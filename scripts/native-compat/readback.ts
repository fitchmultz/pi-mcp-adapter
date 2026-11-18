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
  largeSelection: z.object({ ids: z.array(z.number()), noteLength: z.number(), pages: z.number() }),
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
  const bad = await native.run("mcp", { action: "read-result", ref, path: "/rows" });
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
      const provider = JSON.parse(JSON.parse(text));
      const largeSelection = { ids: provider.rows.map(row => row.id), noteLength: provider.note.length, pages };
      let rejected;
      try { await read(ref, "/rows", 0); }
      catch (error) { rejected = error.message; }
      return { inline, large, selected, defaultPage, largeSelection, rejected };`,
  });

  const [directText] = textOf(good);
  assert.equal(good.isError, false);
  assert.equal(directText, JSON.stringify('{"rows":[{"id":7}],"note":"direct"}'));
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
  assert.equal(coded.isError, false, textOf(coded).join("\n"));
  const [, output] = textOf(coded);
  assert.ok(output !== undefined);
  const { inline, large, selected, defaultPage, largeSelection, rejected } = codedSchema.parse(
    JSON.parse(output),
  );
  assert.equal(inline.mcpResult.content[0].text, '{"rows":[{"id":7}],"note":"inline-json"}');
  assert.equal(selected.text, JSON.stringify(inline.mcpResult.content[0].text));
  assert.equal(defaultPage, selected.text);
  assert.deepEqual(largeSelection.ids, [7]);
  assert.equal(largeSelection.noteLength, 20_000);
  assert.ok(largeSelection.pages > 1);
  assert.match(rejected, /JSON Pointer .*\/rows/);
  const retained = artifactSchema.parse(
    JSON.parse(await readFile(large.mcpAdapter.resultRef, "utf8")),
  );
  assert.equal(retained.content[0].text, `{"rows":[{"id":7}],"note":"${"雪".repeat(20_000)}"}`);
  assert.deepEqual(fixture.wire.effects.slice(effectsBefore), [
    "direct",
    "inline-json",
    "large-json",
  ]);
  console.log(
    "[native-tools] MCP protocol envelope, codemode ref/page, and failed readback passed",
  );
}
