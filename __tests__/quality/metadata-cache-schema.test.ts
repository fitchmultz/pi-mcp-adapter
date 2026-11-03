import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("checks generated cache schema freshness without rewriting stale output", () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-cache-schema-"));
  try {
    mkdirSync(join(root, "scripts"));
    for (const file of [
      "package.json",
      ".oxfmtrc.json",
      "metadata-cache-validator.ts",
      "scripts/generate-metadata-cache-schema.mts",
    ]) {
      copyFileSync(join(process.cwd(), file), join(root, file));
    }
    symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"), "junction");
    const generator = join(root, "scripts/generate-metadata-cache-schema.mts");
    const output = join(root, "metadata-cache-validator.ts");
    const original = readFileSync(generator, "utf8");
    const generated = readFileSync(output, "utf8");
    const check = () =>
      spawnSync(process.execPath, [generator, "--check"], { cwd: root, encoding: "utf8" });

    const valid = check();
    expect(valid.status, valid.stderr).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(generated);

    writeFileSync(
      generator,
      original.replace(
        'z.enum(["eager", "stream-first"])',
        'z.enum(["eager", "stream-first", "future-mode"])',
      ),
    );
    const stale = check();
    expect(stale.status).not.toBe(0);
    expect(stale.stderr).toContain("Metadata cache schema is stale");
    expect(readFileSync(output, "utf8")).toBe(generated);

    writeFileSync(generator, original);
    const restored = check();
    expect(restored.status, restored.stderr).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(generated);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
