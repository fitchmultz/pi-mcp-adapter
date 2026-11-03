import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  chmodSync,
  renameSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { parseJsonConfig } from "./config-imports.ts";
import { isConfigObject } from "./config-validation.ts";
import { buildUnifiedDiff } from "./config-diff.ts";
import type { ConfigWritePreview } from "./config-contracts.ts";

function serializeRawConfig(raw: Record<string, unknown>): string {
  return `${JSON.stringify(raw, null, 2)}\n`;
}

export function buildConfigWritePreview(
  filePath: string,
  nextRaw: Record<string, unknown>,
): ConfigWritePreview {
  const existed = existsSync(filePath);
  const beforeRaw = readRawConfigObject(filePath);
  const beforeText = existed ? serializeRawConfig(beforeRaw) : "";
  const afterText = serializeRawConfig(nextRaw);
  return {
    path: filePath,
    existed,
    changed: beforeText !== afterText,
    beforeText,
    afterText,
    diffText: buildUnifiedDiff(beforeText, afterText),
  };
}

export function readRawConfigObject(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) {
    return {};
  }

  let raw: unknown;
  try {
    raw = parseJsonConfig(readFileSync(filePath, "utf-8"));
  } catch (error) {
    throw new Error(
      `Cannot read MCP config at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!isConfigObject(raw)) {
    throw new Error(`Invalid MCP config at ${filePath}: expected an object`);
  }
  return raw;
}

export function writeRawConfigObject(filePath: string, raw: Record<string, unknown>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const existingMode = existsSync(filePath) ? statSync(filePath).mode & 0o7777 : undefined;
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(raw, null, 2)}\n`, {
    encoding: "utf-8",
    mode: existingMode ?? 0o666,
    flag: "wx",
  });
  if (existingMode !== undefined) {
    chmodSync(tmpPath, existingMode);
  }
  renameSync(tmpPath, filePath);
}

export function getServersObject(
  raw: Record<string, unknown>,
  filePath: string,
): Record<string, unknown> {
  const selected = raw[getServersKey(raw)];
  const existing = selected === undefined ? {} : selected;
  if (!isConfigObject(existing)) {
    throw new Error(`Invalid MCP config at ${filePath}: mcpServers must be an object`);
  }
  return existing;
}

export function withServersObject(
  raw: Record<string, unknown>,
  servers: Record<string, unknown>,
): Record<string, unknown> {
  const updated: Record<string, unknown> = { ...raw, mcpServers: servers };
  delete updated["mcp-servers"];
  return updated;
}

export function getServersKey(raw: Record<string, unknown>): "mcpServers" | "mcp-servers" {
  if (raw.mcpServers !== undefined) {
    return "mcpServers";
  }
  if (raw["mcp-servers"] !== undefined) {
    return "mcp-servers";
  }
  return "mcpServers";
}
