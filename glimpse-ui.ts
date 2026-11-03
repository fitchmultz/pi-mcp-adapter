import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { platform } from "node:os";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { z } from "zod";

let glimpseAvailable: boolean | null = null;
let resolvedBinaryPath: string | null = null;

export function isGlimpseAvailable(): boolean {
  if (glimpseAvailable !== null) {
    return glimpseAvailable;
  }
  if (platform() !== "darwin") {
    glimpseAvailable = false;
    return false;
  }
  resolvedBinaryPath = getGlimpseBinaryPath();
  glimpseAvailable = resolvedBinaryPath !== null;
  return glimpseAvailable;
}

function getGlimpseBinaryPath(): string | null {
  const override = process.env.GLIMPSE_BINARY;
  if (override !== undefined && override !== "" && existsSync(override)) {
    return override;
  }
  try {
    const require = createRequire(import.meta.url);
    const binaryPath = join(dirname(require.resolve("glimpseui")), "glimpse");
    if (existsSync(binaryPath)) {
      return binaryPath;
    }
  } catch {
    // The optional local installation is absent; try the global installation.
  }
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf-8" }).trim();
    const binaryPath = join(globalRoot, "glimpseui", "src", "glimpse");
    if (existsSync(binaryPath)) {
      return binaryPath;
    }
  } catch {
    // No usable optional installation was found.
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
  const modulePath =
    resolvedBinaryPath !== null && resolvedBinaryPath !== ""
      ? join(dirname(resolvedBinaryPath), "glimpse.mjs")
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
