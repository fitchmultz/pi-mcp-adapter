import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DEFAULT_MCP_READ_ALL_MAX_BYTES,
  guardMcpOutput,
  readMcpResult,
  resolveMcpOutputGuardOptions,
  retainMcpResult,
  saveMcpOutputStream,
} from "../../mcp-output-guard.ts";

describe("guardMcpOutput", () => {
  it("includes readback notices in the output budget and returned byte count", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "mcp-guard-budget-"));
    try {
      const text = "x".repeat(3000);
      const guarded = await guardMcpOutput([{ type: "text", text }], {
        outputDirectory,
        maxBytes: 1024,
        rawMcpResult: { content: [{ type: "text", text }], structuredContent: { ok: true } },
      });
      const returned = guarded.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      expect(Buffer.byteLength(returned)).toBeLessThanOrEqual(1024);
      expect(guarded.outputGuard?.returnedBytes).toBe(Buffer.byteLength(returned));
      expect(returned).toContain(guarded.resultRef);
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it("leaves small MCP output unchanged and keeps the raw result in details", async () => {
    const rawMcpResult = {
      content: [{ type: "text", text: "small result" }],
      isError: false,
      structuredContent: { ok: true },
    };
    const guarded = await guardMcpOutput([{ type: "text", text: "small result" }], {
      rawMcpResult,
    });

    expect(guarded.content).toEqual([{ type: "text", text: "small result" }]);
    assert.ok(typeof guarded.resultRef === "string");
    expect(guarded.outputGuard).toBeUndefined();
    expect(guarded.mcpResult).toBe(rawMcpResult);
  });

  it("keeps borderline maxBytes - 100 responses with structuredContent untruncated and footer-free", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "mcp-guard-borderline-"));
    try {
      const maxBytes = 4096;
      const text = "a".repeat(maxBytes - 100);
      const guarded = await guardMcpOutput([{ type: "text", text }], {
        outputDirectory,
        maxBytes,
        rawMcpResult: { content: [{ type: "text", text }], structuredContent: { ok: true } },
      });

      expect(guarded.outputGuard).toBeUndefined();
      expect(guarded.content).toEqual([{ type: "text", text }]);
      expect(guarded.resultRef).toEqual(expect.any(String));
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it("still emits an inline result reference for untruncated responses with extra top-level fields", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "mcp-guard-vendor-"));
    try {
      const rawMcpResult = {
        content: [{ type: "text", text: "done" }],
        vendorField: { cursor: "abc" },
      };
      const guarded = await guardMcpOutput([{ type: "text", text: "done" }], {
        outputDirectory,
        rawMcpResult,
      });

      expect(guarded.outputGuard).toBeUndefined();
      assert.ok(typeof guarded.resultRef === "string");
      expect(guarded.content).toHaveLength(2);
      const notice = guarded.content[1];
      assert.ok(notice?.type === "text");
      expect(notice.text).toContain("[MCP result saved:");
      expect(notice.text).toContain(guarded.resultRef);

      const retained = await retainMcpResult(rawMcpResult, { outputDirectory, detailsMaxBytes: 1 });
      const viaRetained = await guardMcpOutput([{ type: "text", text: "done" }], {
        outputDirectory,
        retainedMcpResult: retained,
      });
      expect(viaRetained.outputGuard).toBeUndefined();
      expect(viaRetained.content).toHaveLength(2);
      const retainedNotice = viaRetained.content[1];
      assert.ok(retainedNotice?.type === "text");
      expect(retainedNotice.text).toContain(retained.resultRef);

      const malformed = await guardMcpOutput([{ type: "text", text: "raw" }], {
        outputDirectory,
        rawMcpResult: "malformed-envelope",
      });
      expect(malformed.outputGuard).toBeUndefined();
      assert.ok(typeof malformed.resultRef === "string");
      expect(malformed.content).toHaveLength(2);
      const malformedNotice = malformed.content[1];
      assert.ok(malformedNotice?.type === "text");
      expect(malformedNotice.text).toContain(malformed.resultRef);
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it("merges prefixes and suffixes into small text output", async () => {
    const guarded = await guardMcpOutput([{ type: "text", text: "server failed" }], {
      prefix: "Error: ",
      suffix: "\n\nExpected parameters:\n{}",
    });

    expect(guarded.content).toEqual([
      { type: "text", text: "Error: server failed\n\nExpected parameters:\n{}" },
    ]);
  });

  it("uses the empty text fallback before applying affixes", async () => {
    const guarded = await guardMcpOutput([{ type: "text", text: "" }], {
      prefix: "Error: ",
      emptyTextFallback: "Tool execution failed",
    });

    expect(guarded.content).toEqual([{ type: "text", text: "Error: Tool execution failed" }]);

    const image = { type: "image" as const, data: "abc", mimeType: "image/png" };
    const withImage = await guardMcpOutput([image], {
      prefix: "Error: ",
      emptyTextFallback: "Tool execution failed",
    });

    expect(withImage.content).toEqual([
      { type: "text", text: "Error: Tool execution failed" },
      image,
    ]);
  });

  it("truncates large text output and saves the full output to a file", async () => {
    const text = Array.from({ length: 20 }, (_, i) => `line-${i} ${"x".repeat(40)}`).join("\n");
    const guarded = await guardMcpOutput([{ type: "text", text }], {
      maxBytes: 300,
      maxLines: 8,
      detailsMaxBytes: 200,
      rawMcpResult: {
        content: [{ type: "text", text }],
        isError: false,
        structuredContent: { rows: [text] },
      },
    });

    expect(guarded.outputGuard).toMatchObject({
      truncated: true,
      originalLines: 20,
    });
    expect(guarded.outputGuard?.fullOutputPath).toBeTruthy();
    expect(guarded.content).toHaveLength(2);
    assert.ok(typeof guarded.resultRef === "string");
    const notice = guarded.content[1];
    assert.ok(notice?.type === "text");
    expect(notice.text).toContain(guarded.resultRef);
    expect(guarded.content[0]).toMatchObject({ type: "text" });
    const first = guarded.content[0];
    assert.ok(first?.type === "text");
    const returnedText = first.text;
    expect(returnedText).toContain("MCP text output truncated");
    expect(returnedText).toContain("Full text saved to:");
    expect(returnedText).not.toContain("line-19");

    assert.ok(typeof guarded.outputGuard?.fullOutputPath === "string");
    const saved = await readFile(guarded.outputGuard.fullOutputPath, "utf8");
    expect(saved).toBe(text);

    const summary = z.looseObject({ fullResultPath: z.string() }).parse(guarded.mcpResult);
    expect(summary).toMatchObject({ omitted: true, isError: false, contentBlocks: 1 });
    expect(summary.fullResultPath).toBeTruthy();
    expect(summary.structuredContentSummary).toMatchObject({ omitted: true });
    expect(summary).not.toHaveProperty("structuredContent");
    expect(JSON.stringify(summary)).not.toContain("line-19");
  });

  it("summarizes details.mcpResult only when it exceeds detailsMaxBytes", async () => {
    const rawMcpResult = {
      content: [{ type: "text", text: "ok" }],
      isError: false,
      structuredContent: { rows: "y".repeat(500) },
    };
    const kept = await guardMcpOutput([{ type: "text", text: "ok" }], {
      detailsMaxBytes: 5000,
      rawMcpResult,
    });
    expect(kept.mcpResult).toBe(rawMcpResult);

    const summarized = await guardMcpOutput([{ type: "text", text: "ok" }], {
      detailsMaxBytes: 100,
      rawMcpResult,
    });
    const summary = z.looseObject({ fullResultPath: z.string() }).parse(summarized.mcpResult);
    expect(summary.omitted).toBe(true);
    expect(summary.fullResultPath).toBeTruthy();
  });

  it("spills the oversized raw result as compact JSON and reports its compact byte size", async () => {
    const rawMcpResult = {
      content: [{ type: "text", text: "ok" }],
      isError: false,
      structuredContent: { rows: "z".repeat(500) },
    };
    const guarded = await guardMcpOutput([{ type: "text", text: "ok" }], {
      detailsMaxBytes: 50,
      rawMcpResult,
    });

    const summary = z
      .looseObject({ fullResultPath: z.string(), rawResultBytes: z.number() })
      .parse(guarded.mcpResult);
    expect(summary.omitted).toBe(true);
    expect(summary.fullResultPath).toBeTruthy();

    const compact = JSON.stringify(rawMcpResult);
    const saved = await readFile(summary.fullResultPath, "utf8");
    expect(saved).toBe(compact);
    expect(saved).not.toContain("\n");
    expect(summary.rawResultBytes).toBe(Buffer.byteLength(compact, "utf8"));
  });

  it("passes image blocks through untouched, even large ones", async () => {
    const image = { type: "image" as const, data: "A".repeat(100_000), mimeType: "image/png" };
    const guarded = await guardMcpOutput([image, { type: "text", text: "caption" }], {
      maxBytes: 1000,
      maxLines: 10,
    });

    expect(guarded.outputGuard).toBeUndefined();
    expect(guarded.content).toEqual([image, { type: "text", text: "caption" }]);
  });

  it("keeps image blocks when text output is truncated", async () => {
    const text = Array.from({ length: 50 }, (_, i) => `row-${i}`).join("\n");
    const image = { type: "image" as const, data: "abc", mimeType: "image/png" };
    const guarded = await guardMcpOutput([{ type: "text", text }, image], {
      maxBytes: 250,
      maxLines: 5,
    });

    expect(guarded.outputGuard).toMatchObject({ truncated: true, imageBlocksPassedThrough: 1 });
    expect(guarded.content).toHaveLength(2);
    expect(guarded.content[0]?.type).toBe("text");
    expect(guarded.content[1]).toEqual(image);

    assert.ok(typeof guarded.outputGuard?.fullOutputPath === "string");
    const saved = await readFile(guarded.outputGuard.fullOutputPath, "utf8");
    expect(saved).toBe(text);
  });

  it("truncates on line count alone", async () => {
    const text = Array.from({ length: 30 }, (_, i) => `entry-${i}`).join("\n");
    const guarded = await guardMcpOutput([{ type: "text", text }], {
      maxBytes: 10_000,
      maxLines: 10,
    });

    expect(guarded.outputGuard).toMatchObject({ truncated: true, originalLines: 30 });
    const first = guarded.content[0];
    assert.ok(first?.type === "text");
    const returnedText = first.text;
    expect(returnedText).toContain("entry-0");
    expect(returnedText).not.toContain("entry-29");
  });

  it.each(["", "OK\n"])("keeps a byte-bounded head after prefix %j", async (prefix) => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "mcp-guard-single-line-"));
    try {
      const text = prefix + JSON.stringify({ a: "x".repeat(20_000) });
      const guarded = await guardMcpOutput([{ type: "text", text }], {
        outputDirectory,
        maxBytes: 1024,
        rawMcpResult: { content: [{ type: "text", text }] },
      });

      const first = guarded.content[0];
      assert.ok(first?.type === "text");
      expect(first.text.startsWith(`${prefix}{"a":"xxx`)).toBe(true);
      expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(1024);
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it("cuts the single-line head on a character boundary", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "mcp-guard-single-line-utf8-"));
    try {
      const text = "€".repeat(5_000);
      const guarded = await guardMcpOutput([{ type: "text", text }], {
        outputDirectory,
        maxBytes: 1024,
        rawMcpResult: { content: [{ type: "text", text }] },
      });

      const first = guarded.content[0];
      assert.ok(first?.type === "text");
      expect(first.text).not.toContain("\uFFFD");
      expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(1024);
      expect(guarded.outputGuard?.returnedBytes).toBeLessThanOrEqual(1024);
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it("keeps prefixes and suffixes inside the saved full output", async () => {
    const guarded = await guardMcpOutput([{ type: "text", text: "body" }], {
      prefix: "Error: ",
      suffix: "\n\nExpected parameters:\n{}",
      maxBytes: 10,
      maxLines: 2,
    });

    expect(guarded.outputGuard?.fullOutputPath).toBeTruthy();
    assert.ok(typeof guarded.outputGuard?.fullOutputPath === "string");
    const saved = await readFile(guarded.outputGuard.fullOutputPath, "utf8");
    expect(saved).toBe("Error: body\n\nExpected parameters:\n{}");
  });

  it("can be disabled to return raw output and raw details", async () => {
    const text = "x".repeat(1000);
    const rawMcpResult = { content: [{ type: "text", text }], isError: false };
    const guarded = await guardMcpOutput([{ type: "text", text }], {
      enabled: false,
      maxBytes: 10,
      maxLines: 1,
      rawMcpResult,
    });

    expect(guarded.content).toEqual([{ type: "text", text }]);
    expect(guarded.outputGuard).toBeUndefined();
    expect(guarded.mcpResult).toBe(rawMcpResult);

    const withPrefix = await guardMcpOutput([{ type: "text", text: "body" }], {
      enabled: false,
      prefix: "Error: ",
      rawMcpResult,
    });

    expect(withPrefix.content).toEqual([{ type: "text", text: "Error: body" }]);
  });

  it("returns no mcpResult when rawMcpResult is not provided", async () => {
    const guarded = await guardMcpOutput([{ type: "text", text: "x" }], {});
    expect(guarded.mcpResult).toBeUndefined();
  });
});

describe("resolveMcpOutputGuardOptions", () => {
  it("defaults to enabled with standard limits", () => {
    expect(resolveMcpOutputGuardOptions()).toEqual({
      enabled: true,
      maxBytes: 50 * 1024,
      maxLines: 2000,
      detailsMaxBytes: 16 * 1024,
      readAllMaxBytes: DEFAULT_MCP_READ_ALL_MAX_BYTES,
    });
  });

  it("supports boolean and object settings", () => {
    expect(resolveMcpOutputGuardOptions({ outputGuard: false }).enabled).toBe(false);
    expect(resolveMcpOutputGuardOptions({ outputGuard: true }).enabled).toBe(true);
    expect(
      resolveMcpOutputGuardOptions({ outputGuard: { maxBytes: 1234, maxLines: 50 } }),
    ).toMatchObject({
      enabled: true,
      maxBytes: 1234,
      maxLines: 50,
      detailsMaxBytes: 16 * 1024,
    });
  });

  it("honors the MCP_OUTPUT_GUARD env kill switch", () => {
    const previous = process.env.MCP_OUTPUT_GUARD;
    try {
      process.env.MCP_OUTPUT_GUARD = "0";
      expect(resolveMcpOutputGuardOptions({ outputGuard: true }).enabled).toBe(false);
      process.env.MCP_OUTPUT_GUARD = "1";
      expect(resolveMcpOutputGuardOptions({ outputGuard: false }).enabled).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.MCP_OUTPUT_GUARD;
      } else {
        process.env.MCP_OUTPUT_GUARD = previous;
      }
    }
  });
});

describe("readMcpResult readAll", () => {
  it("validates readAll format and paging incompatibility at runtime", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "mcp-readall-validate-"));
    try {
      const saved = await retainMcpResult({ structuredContent: { ok: true } }, { outputDirectory });
      assert.ok(typeof saved.resultRef === "string");
      const ref = saved.resultRef;

      const noFormat = await readMcpResult({ ref, readAll: true }, { outputDirectory });
      assert.ok("isError" in noFormat);
      expect(noFormat.isError).toBe(true);
      expect(noFormat.details).toMatchObject({
        error: "result_read_failed",
        message: 'readAll requires format: "structured"',
      });

      const withOffset = await readMcpResult(
        { ref, format: "structured", readAll: true, offset: 0 },
        { outputDirectory },
      );
      assert.ok("isError" in withOffset);
      expect(withOffset.isError).toBe(true);
      expect(withOffset.details).toMatchObject({
        error: "result_read_failed",
        message: "readAll cannot be combined with offset or limit",
      });

      const withLimit = await readMcpResult(
        { ref, format: "structured", readAll: true, limit: 100 },
        { outputDirectory },
      );
      assert.ok("isError" in withLimit);
      expect(withLimit.isError).toBe(true);
      expect(withLimit.details).toMatchObject({
        error: "result_read_failed",
        message: "readAll cannot be combined with offset or limit",
      });
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it("returns the full multi-page selection in structuredContent while bounding content", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "mcp-readall-full-"));
    try {
      const rows = Array.from({ length: 2200 }, (_, i) => ({
        id: i,
        payload: `row-${i}-${"x".repeat(30)}`,
      }));
      const saved = await retainMcpResult(
        { structuredContent: { rows } },
        { outputDirectory, detailsMaxBytes: 1 },
      );
      assert.ok(typeof saved.resultRef === "string");
      const expected = JSON.stringify(rows, null, 2);
      expect(Buffer.byteLength(expected, "utf8")).toBeGreaterThan(50 * 1024);
      expect(expected.split("\n").length).toBeGreaterThan(2000);

      const full = await readMcpResult(
        {
          ref: saved.resultRef,
          path: "/structuredContent/rows",
          format: "structured",
          readAll: true,
        },
        { outputDirectory },
      );
      assert.ok(full.details.error === undefined, full.details.message);
      assert.ok(!("isError" in full));
      const resolvedRef = await realpath(saved.resultRef);
      expect(full.structuredContent).toEqual({
        text: expected,
        ref: resolvedRef,
        path: "/structuredContent/rows",
        offset: 0,
        nextOffset: null,
        totalCharacters: expected.length,
      });
      expect(full.details).toEqual({
        ref: resolvedRef,
        path: "/structuredContent/rows",
        offset: 0,
        nextOffset: null,
        totalCharacters: expected.length,
      });
      const visible = full.content.map((block) => block.text).join("\n");
      expect(Buffer.byteLength(visible, "utf8")).toBeLessThanOrEqual(50 * 1024);
      expect(visible.split("\n").length).toBeLessThanOrEqual(2000);
      expect(visible).toContain("preview truncated");

      const plainText = Array.from(
        { length: 2200 },
        (_, i) => `plain-line-${i}-${"y".repeat(30)}`,
      ).join("\n");
      const plainArtifact = await saveMcpOutputStream(
        (async function* () {
          yield plainText;
        })(),
        outputDirectory,
      );
      assert.ok(typeof plainArtifact.path === "string");
      const plainFull = await readMcpResult(
        { ref: plainArtifact.path, format: "structured", readAll: true },
        { outputDirectory },
      );
      assert.ok(plainFull.details.error === undefined, plainFull.details.message);
      assert.ok(!("isError" in plainFull));
      const resolvedPlainRef = await realpath(plainArtifact.path);
      expect(plainFull.structuredContent).toEqual({
        text: plainText,
        ref: resolvedPlainRef,
        offset: 0,
        nextOffset: null,
        totalCharacters: plainText.length,
      });
      const plainVisible = plainFull.content.map((block) => block.text).join("\n");
      expect(Buffer.byteLength(plainVisible, "utf8")).toBeLessThanOrEqual(50 * 1024);
      expect(plainVisible.split("\n").length).toBeLessThanOrEqual(2000);
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it("fails cleanly when readAll exceeds readAllMaxBytes on both mcp-result and output artifacts", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "mcp-readall-limit-"));
    try {
      const bigPayload = "z".repeat(4096);
      const saved = await retainMcpResult(
        { structuredContent: { bigPayload } },
        { outputDirectory, detailsMaxBytes: 1 },
      );
      assert.ok(typeof saved.resultRef === "string");
      const jsonRejected = await readMcpResult(
        { ref: saved.resultRef, path: "/structuredContent", format: "structured", readAll: true },
        { outputDirectory, readAllMaxBytes: 1024 },
      );
      assert.ok("isError" in jsonRejected);
      expect(jsonRejected.isError).toBe(true);
      expect(jsonRejected.details.error).toBe("result_read_failed");
      expect(jsonRejected.details.message).toContain("1024 bytes");
      expect(jsonRejected.details.message).toContain("path/fields");
      expect(jsonRejected.details.message).toContain("offset/limit");

      const plainArtifact = await saveMcpOutputStream(
        (async function* () {
          yield bigPayload;
        })(),
        outputDirectory,
      );
      assert.ok(typeof plainArtifact.path === "string");
      const plainRejected = await readMcpResult(
        { ref: plainArtifact.path, format: "structured", readAll: true },
        { outputDirectory, readAllMaxBytes: 1024 },
      );
      assert.ok("isError" in plainRejected);
      expect(plainRejected.isError).toBe(true);
      expect(plainRejected.details.error).toBe("result_read_failed");
      expect(plainRejected.details.message).toContain("4096 bytes");
      expect(plainRejected.details.message).toContain("1024 bytes");
      expect(plainRejected.details.message).toContain("offset/limit");
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });
});
