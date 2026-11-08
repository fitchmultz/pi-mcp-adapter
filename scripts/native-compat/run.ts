import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { z } from "zod";
import { NativeFixture, type NativeSession } from "./fixture.ts";
import { verifyCli } from "./cli-proof.ts";
import { instructions } from "./wire.ts";

const probeSchema = z.object({
  outcome: z.object({
    isError: z.boolean(),
    result: z.object({
      structuredContent: z.unknown().optional(),
      content: z.unknown().optional(),
    }),
  }),
});
const savedSchema = z.object({ outputGuard: z.object({ fullOutputPath: z.string() }) });
const pageSchema = z.object({
  totalCharacters: z.number(),
  nextOffset: z.number().nullable().optional(),
});

function outcome(result: ToolResultMessage): z.output<typeof probeSchema>["outcome"] {
  return probeSchema.parse(result.details).outcome;
}

/** Returns the leaf whose recorded loadout predates the catalog load. */
async function verifyComposition(f: NativeFixture, native: NativeSession): Promise<string> {
  const { session } = native;
  assert.ok(!session.getCallableToolNames().includes("local_echo"));
  assert.ok(session.getActiveToolNames().includes("mcp"), "gateway is active from startup");
  assert.equal(outcome(await native.run("native_probe", { value: "inactive" })).isError, true);
  assert.deepEqual(f.wire.effects, []);
  const anchor = session.sessionManager.getLeafId();
  assert.ok(anchor !== null);
  const discovered = await native.run("mcp", { action: "connect", server: "local" });
  assert.ok(session.getCallableToolNames().includes("local_echo"), JSON.stringify(discovered));
  assert.ok(!session.getActiveToolNames().includes("local_echo"), "catalog tools start deferred");
  assert.ok(!session.getAllTools().some((tool) => tool.name === "local_app_only"));
  const echo = session.getAllTools().find((tool) => tool.name === "local_echo");
  assert.ok(echo);
  assert.equal(echo.exposure, "deferred");
  assert.equal(echo.namespace?.instructions, instructions);
  session.setActiveToolsByName([...session.getActiveToolNames(), "tool_search"]);
  const loaded = await native.run("tool_search", { query: "echo" });
  assert.ok(session.getActiveToolNames().includes("local_echo"), JSON.stringify(loaded));
  const success = await native.run("native_probe", { value: "ok" });
  assert.deepEqual(outcome(success).result.structuredContent, { value: "ok" });
  assert.equal(outcome(success).isError, false);
  const firstCall = success.nestedCalls?.calls[0];
  assert.ok(firstCall, "native nested call must be recorded");
  assert.ok(firstCall.id.startsWith(success.toolCallId + "/"));
  assert.equal(firstCall.status, "ok");
  assert.ok(!("result" in firstCall));
  const failure = await native.run("native_probe", { value: "fail" });
  assert.equal(outcome(failure).isError, true);
  assert.deepEqual(outcome(failure).result.structuredContent, { value: "fail" });
  assert.match(JSON.stringify(outcome(failure).result.content), /Human fail/);
  const redacted = await native.run("native_probe", { value: "redact" });
  assert.equal(outcome(redacted).result.structuredContent, undefined);
  assert.deepEqual(outcome(redacted).result.content, [{ type: "text", text: "Redacted" }]);
  const count = f.wire.effects.length;
  assert.equal(outcome(await native.run("native_probe", { value: "blocked" })).isError, true);
  assert.equal(outcome(await native.run("native_probe", { wrong: true })).isError, true);
  assert.equal(f.wire.effects.length, count);
  session.setActiveToolsByName([...session.getActiveToolNames(), "codemode"]);
  const coded = await native.run("codemode", {
    code: 'return await tools.local_echo({value:"coded"});',
  });
  assert.equal(coded.isError, false);
  assert.match(JSON.stringify(coded.content), /coded/);
  assert.doesNotMatch(JSON.stringify(coded.content), /SYNTHETIC-SECRET|Human coded/);
  return anchor;
}

/** Pi owns which loaded tools a branch declares; the adapter only keeps the catalog registered. */
async function verifySelection(
  f: NativeFixture,
  native: NativeSession,
  anchor: string,
  selected: string | null,
): Promise<NativeSession> {
  const { session } = native;
  await session.navigateTree(anchor, { summarize: false });
  assert.ok(!session.getActiveToolNames().includes("local_echo"), "earlier branch never loaded it");
  assert.ok(session.getCallableToolNames().includes("local_echo"), "deferred tools stay callable");
  assert.ok(selected !== null);
  await session.navigateTree(selected, { summarize: false });
  assert.ok(session.getActiveToolNames().includes("local_echo"), "loaded branch declares it");
  await session.reload();
  assert.ok(session.getActiveToolNames().includes("local_echo"), "reload keeps the loaded tool");
  const manager = session.sessionManager;
  await f.release(native);
  const resumed = await f.make({ manager });
  assert.ok(
    resumed.session.getCallableToolNames().includes("local_echo"),
    "resume registers the cached catalog before the server reconnects",
  );
  return resumed;
}

function firstText(result: ToolResultMessage, reason: string): string {
  const block = result.content[0];
  assert.ok(block, reason);
  assert.ok(block.type === "text");
  return block.text;
}

async function verifySavedOutput(native: NativeSession): Promise<void> {
  const { session } = native;
  assert.equal(
    session.getAllTools().find((tool) => tool.name === "mcp_script")?.exposure,
    "deferred",
  );
  session.setActiveToolsByName([...session.getActiveToolNames(), "mcp_script"]);
  const historyText = "native é😀\n".repeat(30_000);
  const spilled = await native.run("mcp_script", {
    code: 'emit("native é😀\\n".repeat(30_000));',
  });
  const ref = savedSchema.parse(spilled.details).outputGuard.fullOutputPath;
  for (const offset of [0, 220_000, 11_000]) {
    const page = await native.run("mcp", { action: "read-result", ref, offset, limit: 110 });
    assert.equal(
      firstText(page, "saved output must have a first content block"),
      historyText.slice(offset, offset + 110),
    );
    assert.equal(pageSchema.parse(page.details).totalCharacters, historyText.length);
    assert.equal(pageSchema.parse(page.details).nextOffset, offset + 110);
  }
  const scriptPage = await native.run("mcp_script", {
    code: `const page = await tools.readResult({ref:${JSON.stringify(ref)},offset:220000,limit:110}); emit(page.content[0].text);`,
  });
  assert.equal(
    firstText(scriptPage, "script page must have a first content block"),
    historyText.slice(220_000, 220_110),
  );
  await writeFile(ref, "redacted é😀");
  const redactedPage = await native.run("mcp", { action: "read-result", ref });
  assert.equal(
    firstText(redactedPage, "redacted page must have a first content block"),
    "redacted é😀",
  );
  assert.equal(pageSchema.parse(redactedPage.details).totalCharacters, "redacted é😀".length);
  console.log(
    "[native-tools] registered gateway + script saved plain-output pages and rewrite invalidation passed",
  );
}

async function verifyCancellation(f: NativeFixture, native: NativeSession): Promise<void> {
  const pending = native.run("native_probe", { value: "hold" });
  await f.wire.started;
  await native.session.abort();
  await pending;
  f.wire.finishHeld();
  assert.equal(
    f.wire.effects.filter((value) => value === "hold").length,
    1,
    "cancelled effect is never replayed",
  );
  assert.match(readFileSync(f.captured, "utf8"), /SYNTHETIC-SECRET/);
}

async function verifyPinning(f: NativeFixture): Promise<void> {
  const pins = await f.make({ directTools: ["echo"], eager: true });
  assert.ok(pins.session.getActiveToolNames().includes("local_echo"), "pins are active at startup");
  assert.equal(
    pins.session.getAllTools().find((tool) => tool.name === "local_echo")?.exposure,
    "direct",
  );
  const disabled = await f.make({ directTools: true, disabled: true });
  assert.ok(!disabled.session.getAllTools().some((tool) => tool.name === "local_echo"));
  const restricted = await f.make({ directTools: true, tools: ["mcp"] });
  await restricted.run("mcp", { action: "status" });
  assert.deepEqual(restricted.session.getActiveToolNames(), ["mcp"]);
  assert.ok(!restricted.session.getCallableToolNames().includes("local_echo"));
}

const fixture = await NativeFixture.create(process.cwd());
try {
  let native = await fixture.make();
  const anchor = await verifyComposition(fixture, native);
  native = await verifySelection(
    fixture,
    native,
    anchor,
    native.session.sessionManager.getLeafId(),
  );
  await verifySavedOutput(native);
  await verifyCancellation(fixture, native);
  await verifyPinning(fixture);
  await verifyCli(fixture);
  console.log(
    "[native-tools] standalone ESM + native deferred catalog/tool_search/nested/codemode success/failure/redaction/permission/cancel; tree/reload/resume/pins/disabled/restrictions passed",
  );
} finally {
  await fixture.close();
}
