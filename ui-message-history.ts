import { appendFileSync, createReadStream, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import type { UiSessionMessages } from "./types.ts";

type Category = "prompts" | "intents" | "notifications";
type Message = string | UiSessionMessages["intents"][number];

/** Private append-only history; failed writes stay owned in memory, never silently discarded. */
export function createUiMessageHistory(outputDirectory?: string) {
  const messages: UiSessionMessages = { prompts: [], intents: [], notifications: [], contexts: [] };
  let failed = false;
  return {
    messages,
    append(category: Category, value: Message): string | undefined {
      try {
        if (failed) throw new Error(messages.historyError);
        if (!messages.historyRef) {
          const root = outputDirectory === undefined ? tmpdir() : resolve(outputDirectory);
          if (outputDirectory !== undefined) mkdirSync(root, { recursive: true, mode: 0o700 });
          const dir = mkdtempSync(join(root, "pi-mcp-output-"));
          const ref = join(dir, `output-${randomBytes(4).toString("hex")}.txt`);
          writeFileSync(ref, "", { mode: 0o600 });
          messages.historyRef = ref;
          messages.historyBytes = 0;
          messages.historyCount = 0;
        }
        const line = JSON.stringify({ category, value }) + "\n";
        // ponytail: synchronous append owns acceptance order; upgrade to an awaited serial writer if local disk latency becomes material.
        appendFileSync(messages.historyRef, line, { flush: true });
        messages.historyBytes! += Buffer.byteLength(line);
        messages.historyCount!++;
        return undefined;
      } catch (error) {
        failed = true;
        messages.historyError = error instanceof Error ? error.message : String(error);
        if (category === "intents") messages.intents.push(value as UiSessionMessages["intents"][number]);
        else messages[category].push(value as string);
        return `UI history could not be saved; messages remain in memory for recovery: ${messages.historyError}`;
      }
    },
  };
}

export async function* uiMessages(messages: UiSessionMessages, category: Category): AsyncGenerator<Message> {
  if (messages.historyRef && messages.historyBytes) {
    // A failed partial append is not an accepted event; the in-memory tail owns it instead.
    const input = createReadStream(messages.historyRef, { encoding: "utf8", end: messages.historyBytes - 1 });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        const record = JSON.parse(line);
        if (record.category === category) yield record.value;
      }
    } finally { lines.close(); input.destroy(); }
  }
  for (const value of messages[category]) yield value;
}

export async function materializeUiMessages(messages: UiSessionMessages): Promise<UiSessionMessages> {
  const result: UiSessionMessages = { prompts: [], intents: [], notifications: [], contexts: messages.contexts };
  for await (const value of uiMessages(messages, "prompts")) result.prompts.push(value as string);
  for await (const value of uiMessages(messages, "intents")) result.intents.push(value as UiSessionMessages["intents"][number]);
  for await (const value of uiMessages(messages, "notifications")) result.notifications.push(value as string);
  return result;
}
