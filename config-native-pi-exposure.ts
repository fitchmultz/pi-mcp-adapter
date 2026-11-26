import type { McpExposure } from "@earendil-works/pi-coding-agent";
import type { ConfigSourceSpec } from "./config-contracts.ts";
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

export interface NativeServerPolicy extends NativeExposureInput {
  readonly enabled?: boolean;
}

export function pickNativeServerPolicy(
  base: NativeExposureInput & { readonly enabled?: boolean },
): NativeServerPolicy {
  return {
    ...(base.enabled !== undefined ? { enabled: base.enabled } : {}),
    ...(base.exposure !== undefined ? { exposure: base.exposure } : {}),
    ...(base.toolExposure !== undefined ? { toolExposure: { ...base.toolExposure } } : {}),
  };
}

function mergeNativePolicy(
  basePolicy: NativeServerPolicy,
  override: NativeExposureInput & { readonly enabled?: boolean },
): NativeServerPolicy {
  return {
    ...basePolicy,
    ...(override.enabled !== undefined ? { enabled: override.enabled } : {}),
    ...(override.exposure !== undefined ? { exposure: override.exposure } : {}),
    ...(override.toolExposure !== undefined ? { toolExposure: { ...override.toolExposure } } : {}),
  };
}

function stripExposureOverrides(entry: ServerEntry, stripDisabled: boolean): ServerEntry {
  const next = { ...entry };
  delete next.directTools;
  delete next.includeTools;
  delete next.excludeTools;
  delete next.toolExposure;
  if (stripDisabled) {
    delete next.disabled;
  }
  return next;
}

export function updateNativePolicyTracking(
  policies: Map<string, NativeServerPolicy>,
  sourceId: ConfigSourceSpec["id"],
  layer: {
    readonly loadedPolicies?: ReadonlyMap<string, NativeServerPolicy>;
    readonly servers: Readonly<Record<string, ServerEntry>>;
    readonly hasTransport: (entry: ServerEntry) => boolean;
  },
): void {
  if (sourceId === "native-pi-global") {
    for (const [name, policy] of layer.loadedPolicies ?? []) {
      policies.set(name, policy);
    }
    return;
  }
  for (const [name, entry] of Object.entries(layer.servers)) {
    if (layer.hasTransport(entry)) {
      policies.delete(name);
      continue;
    }
    const existing = policies.get(name);
    if (existing !== undefined && entry.disabled !== undefined) {
      policies.set(name, {
        ...existing,
        enabled: entry.disabled === false,
      });
    }
  }
}

function stripDisabledField(entry: ServerEntry): ServerEntry {
  const next = { ...entry };
  delete next.disabled;
  return next;
}

export function buildNativePolicyOverrideEntry(input: {
  readonly base: NativeExposureInput & { readonly enabled?: boolean };
  readonly existing: ServerEntry | undefined;
  readonly nativePolicy: NativeServerPolicy | undefined;
  readonly ctx: NativeEntryContext;
  readonly resolveDisabled: (
    enabled: boolean | undefined,
    hiddenDisabled: boolean,
  ) => Partial<ServerEntry>;
}): { readonly entry: ServerEntry; readonly replacesExisting: boolean } {
  const { base, existing, nativePolicy, ctx, resolveDisabled } = input;
  const hasExplicitExposure = base.exposure !== undefined || base.toolExposure !== undefined;
  if (nativePolicy !== undefined && existing !== undefined) {
    const merged = mergeNativePolicy(nativePolicy, base);
    const mappedExposure = mapNativeExposureFields(merged, ctx);
    const disabledOverride = resolveDisabled(merged.enabled, mappedExposure.disabled === true);
    if (!hasExplicitExposure) {
      return {
        entry: {
          ...stripDisabledField(existing),
          ...disabledOverride,
        },
        replacesExisting: true,
      };
    }
    return {
      entry: {
        ...stripExposureOverrides(existing, true),
        ...mappedExposure,
        ...disabledOverride,
      },
      replacesExisting: true,
    };
  }
  const mappedExposure = mapNativeExposureFields(base, ctx);
  const disabledOverride = resolveDisabled(base.enabled, mappedExposure.disabled === true);
  if (hasExplicitExposure && existing !== undefined) {
    return {
      entry: {
        ...stripExposureOverrides(
          existing,
          base.enabled !== undefined || mappedExposure.disabled === true,
        ),
        ...mappedExposure,
        ...disabledOverride,
      },
      replacesExisting: true,
    };
  }
  return {
    entry: { ...mappedExposure, ...disabledOverride },
    replacesExisting: false,
  };
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
