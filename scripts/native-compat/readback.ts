import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { NativeFixture, NativeSession } from "./fixture.ts";

const textBlock = z.object({ type: z.literal("text"), text: z.string() });
const artifactSchema = z.object({
  content: z.tuple([
    textBlock.extend({ _meta: z.object({ private: z.literal("SYNTHETIC-BLOCK") }) }),
  ]),
  _meta: z.object({ private: z.literal("SYNTHETIC-SECRET") }),
});

const codedSchema = z.object({
  inline: z.object({
    mcpResult: z.object({ content: z.tuple([textBlock.strict()]) }).strict(),
    mcpAdapter: z.object({ resultRef: z.string() }),
  }),
  large: z.object({ mcpAdapter: z.object({ omitted: z.literal(true), resultRef: z.string() }) }),
  selected: z.object({ text: z.string(), offset: z.literal(0), nextOffset: z.null() }),
  defaultPage: z.string(),
  denied: z
    .object({
      isError: z.literal(true),
      mcpAdapter: z
        .object({
          omitted: z.literal(true),
          error: z.literal("approval_required"),
          message: z.string(),
        })
        .strict(),
    })
    .strict(),
  defaultDenial: z.string(),
  providerError: z.object({
    isError: z.literal(true),
    mcpAdapter: z.object({ error: z.literal("tool_error"), omitted: z.literal(false) }),
  }),
  largeSelection: z.object({ ids: z.array(z.number()), noteLength: z.number(), pages: z.number() }),
  largeReadAll: z.object({
    ids: z.array(z.number()),
    noteLength: z.number(),
    offset: z.literal(0),
    nextOffset: z.null(),
    totalCharacters: z.number(),
  }),
  rejected: z.string(),
});

function textOf(result: ToolResultMessage): string[] {
  return result.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
}

export async function verifyPlainTextCodemode(native: NativeSession): Promise<void> {
  const coded = await native.run("codemode", {
    code: `
      const tsv = await tools.local_plain_tsv({ value: "sample" });
      const viaGateway = await tools.mcp({ action: "call", server: "local", tool: "plain_tsv", args: { value: "sample" } });
      if (viaGateway !== tsv) throw new Error("The default gateway should return the same plain text");
      const [, row] = tsv.split("\\n");
      return row.split("\\t");`,
  });
  assert.equal(coded.isError, false, textOf(coded).join("\n"));
  assert.equal(textOf(coded)[1], JSON.stringify(["7", "sample"]));
  console.log("[native-tools] schema-less plain-text direct result still supports TSV splitting");
}

export async function verifyMcpReadback(
  fixture: NativeFixture,
  native: NativeSession,
): Promise<void> {
  const effectsBefore = fixture.wire.effects.length;
  const direct = await native.run("mcp", {
    action: "call",
    server: "local",
    tool: "text_json",
    args: { value: "direct" },
  });
  const ref = z.object({ resultRef: z.string() }).parse(direct.details).resultRef;
  const good = await native.run("mcp", { action: "read-result", ref, path: "/content/0/text" });
  const traversed = await native.run("mcp", { action: "read-result", ref, path: "/rows" });
  const bad = await native.run("mcp", { action: "read-result", ref, path: "/missing" });
  const blocked = {
    action: "call",
    server: "local",
    tool: "approval_echo",
    args: { value: "must-not-run" },
  };
  const deniedNative = await native.run("mcp", { ...blocked, format: "structured" });
  assert.equal(deniedNative.isError, true);
  assert.match(textOf(deniedNative).join("\n"), /approval-gated.*interactive session/);
  const coded = await native.run("codemode", {
    code: `
      const call = (value) => tools.mcp({ action: "call", server: "local", tool: "text_json", args: { value }, format: "structured" });
      const inline = await call("inline-json");
      const large = await call("large-json");
      const ref = inline.mcpAdapter.resultRef;
      const path = "/content/0/text";
      const read = (ref, path, offset) => tools.mcp({ action: "read-result", ref, path, offset, format: "structured" });
      const selected = await read(ref, path, 0);
      const defaultPage = await tools.mcp({ action: "read-result", ref, path });
      let text = "";
      let pages = 0;
      for (let offset = 0; offset !== null;) {
        const page = await read(large.mcpAdapter.resultRef, path, offset);
        text += page.text;
        offset = page.nextOffset;
        pages++;
      }
      const provider = JSON.parse(text);
      const largeSelection = { ids: provider.rows.map(row => row.id), noteLength: provider.note.length, pages };
      const full = await tools.mcp({
        action: "read-result",
        ref: large.mcpAdapter.resultRef,
        path,
        format: "structured",
        readAll: true,
      });
      const fullProvider = JSON.parse(full.text);
      const largeReadAll = {
        ids: fullProvider.rows.map(row => row.id),
        noteLength: fullProvider.note.length,
        offset: full.offset,
        nextOffset: full.nextOffset,
        totalCharacters: full.totalCharacters,
      };
      let rejected;
      try { await read(ref, "/missing", 0); }
      catch (error) { rejected = error.message; }
      const blocked = ${JSON.stringify(blocked)};
      const denied = await tools.mcp({ ...blocked, format: "structured" });
      let defaultDenial;
      try { await tools.mcp(blocked); }
      catch (error) { defaultDenial = error.message; }
      const providerError = await tools.mcp({ ...blocked, tool: "echo", args: { value: "fail" }, format: "structured" });
      return { inline, large, selected, defaultPage, largeSelection, largeReadAll, rejected, denied, defaultDenial, providerError };`,
  });

  const [directText] = textOf(good);
  assert.equal(good.isError, false);
  assert.equal(directText, '{"rows":[{"id":7}],"note":"direct"}');
  assert.equal(traversed.isError, false);
  assert.deepEqual(JSON.parse(textOf(traversed)[0] ?? ""), [{ id: 7 }]);
  assert.equal(
    bad.isError,
    true,
    JSON.stringify({
      directFailure: textOf(bad),
      coded: textOf(coded).map((item) => item.slice(0, 400)),
    }),
  );
  assert.deepEqual(z.object({ error: z.literal("result_read_failed") }).parse(bad.details), {
    error: "result_read_failed",
  });
  assert.match(textOf(bad).join("\n"), /"rows"/);
  assert.equal(coded.isError, false, textOf(coded).join("\n"));
  assert.equal(coded.nestedCalls?.calls.at(-1)?.status, "error");
  const [, output] = textOf(coded);
  assert.ok(output !== undefined);
  assert.deepEqual(fixture.wire.effects.slice(effectsBefore), [
    "direct",
    "inline-json",
    "large-json",
    "fail",
  ]);
  const {
    inline,
    large,
    selected,
    defaultPage,
    largeSelection,
    largeReadAll,
    rejected,
    denied,
    defaultDenial,
  } = codedSchema.parse(JSON.parse(output));
  assert.equal(inline.mcpResult.content[0].text, '{"rows":[{"id":7}],"note":"inline-json"}');
  assert.equal(selected.text, inline.mcpResult.content[0].text);
  assert.equal(defaultPage, selected.text);
  assert.deepEqual(largeSelection.ids, [7]);
  assert.equal(largeSelection.noteLength, 20_000);
  assert.ok(largeSelection.pages > 1);
  assert.deepEqual(largeReadAll.ids, [7]);
  assert.equal(largeReadAll.noteLength, 20_000);
  assert.equal(largeReadAll.offset, 0);
  assert.equal(largeReadAll.nextOffset, null);
  assert.equal(
    largeReadAll.totalCharacters,
    `{"rows":[{"id":7}],"note":"${"雪".repeat(20_000)}"}`.length,
  );
  assert.match(rejected, /JSON Pointer .*\/missing/);
  assert.equal(denied.mcpAdapter.message, defaultDenial);
  assert.match(defaultDenial, /approval-gated.*interactive session/);
  const retained = artifactSchema.parse(
    JSON.parse(await readFile(large.mcpAdapter.resultRef, "utf8")),
  );
  assert.equal(retained.content[0].text, `{"rows":[{"id":7}],"note":"${"雪".repeat(20_000)}"}`);
  console.log(
    "[native-tools] MCP protocol envelope, codemode ref/page, and failed readback passed",
  );
}
