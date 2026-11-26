import type { McpExposure } from "@earendil-works/pi-coding-agent";
import type { ServerEntry } from "./config-types.ts";
import {
  normalizeNativeToolExposure,
  warnNativeField,
  type NativeEntryContext,
} from "./config-native-pi-oauth.ts";

export interface NativeExposureInput {
  readonly exposure?: McpExposure;
  readonly toolExposure?: Record<string, McpExposure>;
}

function collectExactDirectNames(keys: readonly string[], ctx: NativeEntryContext): string[] {
  const exact = keys.filter((key) => !key.includes("*"));
  const globs = keys.filter((key) => key.includes("*"));
  if (globs.length > 0) {
    warnNativeField(
      ctx,
      `wildcard direct toolExposure (${globs.join(", ")}) cannot pin tools in Fitch MCP Adapter`,
    );
  }
  return exact;
}

function hiddenExposureFields(
  visibleKeys: readonly string[],
  hiddenKeys: readonly string[],
  directKeys: readonly string[],
  ctx: NativeEntryContext,
): Partial<ServerEntry> {
  if (visibleKeys.length === 0) {
    return { disabled: true };
  }
  const exact = collectExactDirectNames(directKeys, ctx);
  return {
    includeTools: [...visibleKeys],
    ...(hiddenKeys.length > 0 ? { excludeTools: [...hiddenKeys] } : {}),
    directTools: exact.length > 0 ? exact : false,
  };
}

function directExposureFields(
  entries: ReadonlyArray<[string, McpExposure]>,
  hiddenKeys: readonly string[],
  ctx: NativeEntryContext,
): Partial<ServerEntry> {
  const downgraded = entries
    .filter(([, exp]) => exp === "codemode" || exp === "deferred")
    .map(([key]) => key);
  if (downgraded.length > 0) {
    warnNativeField(
      ctx,
      `per-tool deferred overrides (${downgraded.join(", ")}) remain pinned under directTools: true`,
    );
  }
  return {
    directTools: true,
    ...(hiddenKeys.length > 0 ? { excludeTools: [...hiddenKeys] } : {}),
  };
}

function defaultExposureFields(
  exposure: McpExposure | undefined,
  directKeys: readonly string[],
  hiddenKeys: readonly string[],
  ctx: NativeEntryContext,
): Partial<ServerEntry> {
  const exact = collectExactDirectNames(directKeys, ctx);
  const result: Partial<ServerEntry> = {};
  if (hiddenKeys.length > 0) {
    result.excludeTools = [...hiddenKeys];
  }
  if (exact.length > 0) {
    result.directTools = exact;
  } else if (exposure !== undefined) {
    result.directTools = false;
  }
  return result;
}

function orderedExposureFields(
  exposure: McpExposure | undefined,
  entries: ReadonlyArray<[string, McpExposure]>,
  directKeys: readonly string[],
  ctx: NativeEntryContext,
): Partial<ServerEntry> {
  const toolExposure: Record<string, McpExposure> = Object.fromEntries(entries);
  if (exposure === "hidden" && !Object.hasOwn(toolExposure, "*")) {
    toolExposure["*"] = "hidden";
  }
  if (exposure === "direct") {
    return { ...directExposureFields(entries, [], ctx), toolExposure };
  }
  const exact = collectExactDirectNames(directKeys, ctx);
  const result: Partial<ServerEntry> = { toolExposure };
  if (exact.length > 0) {
    result.directTools = exact;
  } else if (exposure !== undefined) {
    result.directTools = false;
  }
  return result;
}

export function mapNativeExposureFields(
  base: NativeExposureInput,
  ctx: NativeEntryContext,
): Partial<ServerEntry> {
  const normalized = normalizeNativeToolExposure(base.exposure, base.toolExposure);
  const { exposure, entries, requiresOrderedExposure } = normalized;
  const directKeys = entries.filter(([, exp]) => exp === "direct").map(([key]) => key);
  if (requiresOrderedExposure) {
    return orderedExposureFields(exposure, entries, directKeys, ctx);
  }
  const hiddenKeys = entries.filter(([, exp]) => exp === "hidden").map(([key]) => key);
  if (exposure === "hidden") {
    const visibleKeys = entries.filter(([, exp]) => exp !== "hidden").map(([key]) => key);
    return hiddenExposureFields(visibleKeys, hiddenKeys, directKeys, ctx);
  }
  if (exposure === "direct") {
    return directExposureFields(entries, hiddenKeys, ctx);
  }
  return defaultExposureFields(exposure, directKeys, hiddenKeys, ctx);
}
