import { createReadStream, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { UiSessionMessages } from "./types.ts";
import { appendPlainOutput } from "./plain-result-reader.ts";

type Category = "prompts" | "intents" | "notifications";
type Intent = UiSessionMessages["intents"][number];
type Message = string | Intent;
type HistoryEntry =
  | [category: "intents", value: Intent]
  | [category: "prompts" | "notifications", value: string];

const intentSchema = z.looseObject({
  intent: z.string(),
  params: z.record(z.string(), z.unknown()).exactOptional(),
});
const historyRecordSchema = z.discriminatedUnion("category", [
  z.object({ category: z.literal("prompts"), value: z.string() }),
  z.object({ category: z.literal("notifications"), value: z.string() }),
  z.object({ category: z.literal("intents"), value: intentSchema }),
]);
type HistoryRecord = z.input<typeof historyRecordSchema>;

// Validate the persisted original, keeping the native parse error, so arbitrary
// intent parameter keys and their order survive readback.
function assertHistoryRecord(value: unknown): asserts value is HistoryRecord {
  historyRecordSchema.parse(value);
}

interface UiMessageHistory {
  messages: UiSessionMessages;
  append: (...entry: HistoryEntry) => string | undefined;
}

class MessageHistory implements UiMessageHistory {
  readonly messages: UiSessionMessages = {
    prompts: [],
    intents: [],
    notifications: [],
    contexts: [],
  };
  private failed = false;
  private readonly outputDirectory: string | undefined;

  constructor(outputDirectory: string | undefined) {
    this.outputDirectory = outputDirectory;
  }

  private historyRef(): string {
    if (this.messages.historyRef !== undefined && this.messages.historyRef !== "") {
      return this.messages.historyRef;
    }
    const root = this.outputDirectory === undefined ? tmpdir() : resolve(this.outputDirectory);
    if (this.outputDirectory !== undefined) {
      mkdirSync(root, { recursive: true, mode: 0o700 });
    }
    const dir = mkdtempSync(join(root, "pi-mcp-output-"));
    const ref = join(dir, `output-${randomBytes(4).toString("hex")}.txt`);
    writeFileSync(ref, "", { mode: 0o600 });
    this.messages.historyRef = ref;
    this.messages.historyBytes = 0;
    this.messages.historyCount = 0;
    return ref;
  }

  append = (...[category, value]: HistoryEntry): string | undefined => {
    try {
      if (this.failed) {
        throw new Error(this.messages.historyError);
      }
      const ref = this.historyRef();
      const line = JSON.stringify({ category, value }) + "\n";
      // ponytail: synchronous append owns acceptance order; upgrade to an awaited serial writer if local disk latency becomes material.
      appendPlainOutput(ref, line);
      this.messages.historyBytes = (this.messages.historyBytes ?? 0) + Buffer.byteLength(line);
      this.messages.historyCount = (this.messages.historyCount ?? 0) + 1;
      return undefined;
    } catch (error) {
      this.failed = true;
      this.messages.historyError = error instanceof Error ? error.message : String(error);
      if (category === "intents") {
        this.messages.intents.push(value);
      } else {
        this.messages[category].push(value);
      }
      return `UI history could not be saved; messages remain in memory for recovery: ${this.messages.historyError}. Unsaved messages will be lost on reload or process exit.`;
    }
  };
}

/** Private append-only history; failed writes stay owned in memory, never silently discarded. */
export function createUiMessageHistory(outputDirectory?: string): UiMessageHistory {
  return new MessageHistory(outputDirectory);
}

async function* diskMessages(messages: UiSessionMessages): AsyncGenerator<HistoryRecord> {
  if (
    messages.historyRef === undefined ||
    messages.historyRef === "" ||
    (messages.historyBytes ?? 0) === 0
  ) {
    return;
  }
  // A failed partial append is not an accepted event; the in-memory tail owns it instead.
  const input = createReadStream(messages.historyRef, {
    encoding: "utf8",
    end: (messages.historyBytes ?? 0) - 1,
  });
  let bytes = 0;
  let count = 0;
  input.on("data", (chunk: unknown) => {
    if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
      bytes += Buffer.byteLength(chunk);
    }
  });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const record: unknown = JSON.parse(line);
      assertHistoryRecord(record);
      count++;
      yield record;
    }
    if (
      bytes !== messages.historyBytes ||
      (messages.historyCount !== undefined && count !== messages.historyCount)
    ) {
      throw new Error("UI history is incomplete; accepted messages remain pending recovery");
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

export function uiMessages(
  messages: UiSessionMessages,
  category: "intents",
): AsyncGenerator<Intent>;
export function uiMessages(
  messages: UiSessionMessages,
  category: "prompts" | "notifications",
): AsyncGenerator<string>;
export function uiMessages(
  messages: UiSessionMessages,
  category: Category,
): AsyncGenerator<Message>;
export async function* uiMessages(
  messages: UiSessionMessages,
  category: Category,
): AsyncGenerator<Message> {
  for await (const record of diskMessages(messages)) {
    if (record.category === category) {
      yield record.value;
    }
  }
  for (const value of messages[category]) {
    yield value;
  }
}

export async function materializeUiMessages(
  messages: UiSessionMessages,
): Promise<UiSessionMessages> {
  const result: UiSessionMessages = {
    prompts: [],
    intents: [],
    notifications: [],
    contexts: messages.contexts,
  };
  for await (const value of uiMessages(messages, "prompts")) {
    result.prompts.push(value);
  }
  for await (const value of uiMessages(messages, "intents")) {
    result.intents.push(value);
  }
  for await (const value of uiMessages(messages, "notifications")) {
    result.notifications.push(value);
  }
  return result;
}
