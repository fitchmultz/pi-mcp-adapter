import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { platform } from "node:os";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const NPM_ROOT_TIMEOUT_MS = 5_000;

let resolvedBinaryPath: string | null = null;
let pendingLookup: Promise<string | null> | null = null;

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function isGlimpseAvailable(): Promise<boolean> {
  if (platform() !== "darwin") {
    return false;
  }
  const binaryPath = await resolveGlimpseBinaryPath();
  return binaryPath !== null;
}

async function resolveGlimpseBinaryPath(): Promise<string | null> {
  const override = process.env.GLIMPSE_BINARY;
  if (override !== undefined && override !== "" && (await fileExists(override))) {
    return override;
  }
  if (resolvedBinaryPath !== null) {
    if (await fileExists(resolvedBinaryPath)) {
      return resolvedBinaryPath;
    }
    resolvedBinaryPath = null;
  }
  if (pendingLookup) {
    return pendingLookup;
  }
  pendingLookup = probeGlimpseBinaryPath().finally(() => {
    pendingLookup = null;
  });
  const found = await pendingLookup;
  if (found !== null) {
    resolvedBinaryPath = found;
  }
  return found;
}

async function probeGlimpseBinaryPath(): Promise<string | null> {
  try {
    const require = createRequire(import.meta.url);
    const binaryPath = join(dirname(require.resolve("glimpseui")), "glimpse");
    if (await fileExists(binaryPath)) {
      return binaryPath;
    }
  } catch {
    // The optional local installation is absent; try the global installation.
  }
  try {
    const { stdout } = await execFileAsync("npm", ["root", "-g"], {
      encoding: "utf8",
      timeout: NPM_ROOT_TIMEOUT_MS,
    });
    const globalRoot = stdout.trim();
    if (globalRoot !== "") {
      const binaryPath = join(globalRoot, "glimpseui", "src", "glimpse");
      if (await fileExists(binaryPath)) {
        return binaryPath;
      }
    }
  } catch {
    // Do not permanently cache transient lookup failures; retry on a later session.
  }
  return null;
}

export async function openGlimpseWindow(
  html: string,
  options: {
    title: string;
    width?: number;
    height?: number;
    onClosed: () => void;
  },
): Promise<{ close: () => void }> {
  const binaryPath = await resolveGlimpseBinaryPath();
  const modulePath =
    binaryPath !== null && binaryPath !== ""
      ? join(dirname(binaryPath), "glimpse.mjs")
      : "glimpseui";
  const glimpse: unknown = await import(modulePath);
  if (glimpse === null || typeof glimpse !== "object" || !("open" in glimpse)) {
    throw new Error("Glimpse module does not expose open");
  }
  // Glimpse has no published types. Validate only the API used here, preserving
  // the actual EventEmitter instance and receiver for its private process state.
  const open = z
    .function({
      input: [z.string(), z.object({ width: z.number(), height: z.number(), title: z.string() })],
      output: z.instanceof(EventEmitter),
    })
    .parse(glimpse.open);
  const win = open(html, {
    width: options.width ?? 900,
    height: options.height ?? 700,
    title: options.title,
  });
  if (!("close" in win)) {
    throw new Error("Glimpse window does not expose close");
  }
  const close = z.function({ input: [], output: z.void() }).parse(win.close);
  let active = true;
  win.on("closed", () => {
    if (!active) {
      return;
    }
    active = false;
    options.onClosed();
  });
  return {
    close: (): void => {
      if (!active) {
        return;
      }
      active = false;
      close.call(win);
    },
  };
}
