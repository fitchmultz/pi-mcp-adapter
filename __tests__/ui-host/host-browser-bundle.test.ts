import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";

it("checks generated browser freshness without writing, detects source drift, and accepts restored input", () => {
  const root = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "host-browser-freshness-"));
  const bundle = "host-browser.bundle.js";
  const generator = join(root, "scripts/build-host-browser.mjs");
  const originalBundle = readFileSync(join(root, bundle));
  try {
    for (const file of readdirSync(root).filter((name) => /^host-browser-.*\.ts$/u.test(name))) {
      copyFileSync(join(root, file), join(dir, file));
    }
    copyFileSync(join(root, "ui-stream-types.ts"), join(dir, "ui-stream-types.ts"));
    copyFileSync(join(root, "ui-session-timing.ts"), join(dir, "ui-session-timing.ts"));
    copyFileSync(join(root, bundle), join(dir, bundle));
    symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "junction");
    const check = () =>
      spawnSync(process.execPath, [generator, "--check"], { cwd: dir, encoding: "utf8" });
    const valid = check();
    expect(valid.status, valid.stderr).toBe(0);
    expect(readFileSync(join(dir, bundle))).toEqual(originalBundle);

    const entry = join(dir, "host-browser-entry.ts");
    const source = readFileSync(entry, "utf8");
    const changed = source.replace(
      "new HostBrowserProxy(config.sessionToken)",
      'new HostBrowserProxy("stale-control")',
    );
    expect(changed).not.toBe(source);
    writeFileSync(entry, changed);
    const stale = check();
    expect(stale.status, stale.stderr).toBe(1);
    expect(stale.stderr).toContain("host-browser.bundle.js is stale");
    expect(readFileSync(join(dir, bundle))).toEqual(originalBundle);
    writeFileSync(entry, source);
    const restored = check();
    expect(restored.status, restored.stderr).toBe(0);
    expect(readFileSync(join(root, bundle))).toEqual(originalBundle);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
