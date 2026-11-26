import type * as NodeChildProcess from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const platform = vi.fn<() => NodeJS.Platform>(() => "darwin");
  const execFileAsync =
    vi.fn<
      (
        file: string,
        args: readonly string[],
        options: { encoding: string; timeout: number },
      ) => Promise<{ stdout: string; stderr: string }>
    >();
  const execFile = Object.assign(vi.fn<(...args: unknown[]) => void>(), {
    [Symbol.for("nodejs.util.promisify.custom")]: execFileAsync,
  });
  return { platform, execFile, execFileAsync };
});

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  platform: mocks.platform,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeChildProcess>()),
  execFile: mocks.execFile,
}));

async function loadFreshGlimpseUi() {
  vi.resetModules();
  return import("../../glimpse-ui.ts");
}

afterEach(() => {
  vi.unstubAllEnvs();
  mocks.platform.mockReset().mockReturnValue("darwin");
  mocks.execFile.mockReset();
  mocks.execFileAsync.mockReset();
});

describe("glimpse-ui async availability detection", () => {
  it("short-circuits to false on non-darwin platforms without probing npm", async () => {
    mocks.platform.mockReturnValue("linux");
    const { isGlimpseAvailable } = await loadFreshGlimpseUi();

    await expect(isGlimpseAvailable()).resolves.toBe(false);
    expect(mocks.execFileAsync).not.toHaveBeenCalled();
  });

  it("does not permanently cache missing probes, coalesces concurrent probes, caches hits, and re-checks after removal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-glimpse-probe-"));
    try {
      const globalRoot = join(dir, "global-node-modules");
      await mkdir(globalRoot, { recursive: true });
      vi.stubEnv("GLIMPSE_BINARY", "");
      mocks.execFileAsync.mockResolvedValue({ stdout: `${globalRoot}\n`, stderr: "" });
      const { isGlimpseAvailable } = await loadFreshGlimpseUi();

      // Coalesce concurrent negative probes into one single-flight npm root -g call.
      let releaseProbe: (() => void) | undefined;
      mocks.execFileAsync.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseProbe = () => resolve({ stdout: `${globalRoot}\n`, stderr: "" });
          }),
      );
      const inflight = Promise.all([isGlimpseAvailable(), isGlimpseAvailable()]);
      await vi.waitFor(() => {
        expect(releaseProbe).toBeDefined();
      });
      releaseProbe?.();
      await expect(inflight).resolves.toEqual([false, false]);
      expect(mocks.execFileAsync).toHaveBeenCalledTimes(1);

      // A subsequent check must re-probe rather than returning a permanently cached miss.
      await expect(isGlimpseAvailable()).resolves.toBe(false);
      expect(mocks.execFileAsync).toHaveBeenCalledTimes(2);

      // Installing glimpseui under the global root is picked up and then positively cached.
      const globalBinary = join(globalRoot, "glimpseui", "src", "glimpse");
      await mkdir(join(globalRoot, "glimpseui", "src"), { recursive: true });
      await writeFile(globalBinary, "#!/bin/sh\nexit 0\n");
      await expect(isGlimpseAvailable()).resolves.toBe(true);
      expect(mocks.execFileAsync).toHaveBeenCalledTimes(3);

      await expect(isGlimpseAvailable()).resolves.toBe(true);
      expect(mocks.execFileAsync).toHaveBeenCalledTimes(3);

      // Removing the cached binary invalidates the positive cache; GLIMPSE_BINARY override is then picked up.
      await rm(globalBinary);
      await expect(isGlimpseAvailable()).resolves.toBe(false);
      expect(mocks.execFileAsync).toHaveBeenCalledTimes(4);

      const overrideBinary = join(dir, "glimpse-override");
      await writeFile(overrideBinary, "#!/bin/sh\nexit 0\n");
      vi.stubEnv("GLIMPSE_BINARY", overrideBinary);
      await expect(isGlimpseAvailable()).resolves.toBe(true);
      expect(mocks.execFileAsync).toHaveBeenCalledTimes(4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
