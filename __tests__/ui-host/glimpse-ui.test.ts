import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isGlimpseAvailable } from "../../glimpse-ui.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("glimpse-ui async availability detection", () => {
  it("resolves availability asynchronously and picks up GLIMPSE_BINARY when installed later", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-glimpse-probe-"));
    try {
      const fakeBinary = join(dir, "glimpse");
      vi.stubEnv("GLIMPSE_BINARY", fakeBinary);
      // Probe before the binary exists; negative/missing lookups must not permanently lock out later detection.
      const before = await isGlimpseAvailable();
      expect(typeof before).toBe("boolean");

      await writeFile(fakeBinary, "#!/bin/sh\nexit 0\n");
      const after = await isGlimpseAvailable();
      expect(after).toBe(process.platform === "darwin");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
