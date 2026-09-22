import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { createDirectToolExecutor, directToolSelection } from "./direct-tools.ts";
import { isServerCacheValid, reconstructToolMetadata, type MetadataCache } from "./metadata-cache.ts";
import type { McpExtensionState } from "./state.ts";
import { createMcpDirectToolCallRenderer, renderMcpToolResult } from "./tool-result-renderer.ts";
import { isServerDisabled, type DirectToolSpec, type McpAdapterOptions, type McpConfig, type ToolMetadata } from "./types.ts";
import { normalizeDirectToolInputSchema } from "./utils.ts";
import { isToolCallApprovalRequired } from "./tool-approval.ts";

type Reference = { name: string; namespace?: string };
type Selection = { server: string; tool: string };
type SearchDefinition<TParams extends TSchema, TDetails> = Omit<ToolDefinition<TParams, TDetails>, "execute"> & {
  execute: (...args: Parameters<ToolDefinition<TParams, TDetails>["execute"]>) => Promise<AgentToolResult<TDetails> & { tools: Reference[] }>;
};
// Optional fork APIs; official Pi uses the same loader as an ordinary tool.
export type SearchAPI = ExtensionAPI & {
  registerToolSearch?: <TParams extends TSchema, TDetails>(definition: SearchDefinition<TParams, TDetails>) => void;
  getActiveToolReferences?: () => Reference[];
  setActiveToolReferences?: (tools: Reference[]) => void;
};
const ENTRY = "mcp-tool-selection";
const key = (value: Selection) => JSON.stringify([value.server, value.tool]);
const refKey = (value: Reference) => JSON.stringify([value.namespace ?? null, value.name]);
const reserved = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls", "mcp", "mcp_search", "mcp_script"]);

export function supportsNativeAsync(ctx: ExtensionContext): boolean {
  const compat = ctx.model?.compat;
  return "getPendingToolCalls" in ctx && typeof ctx.getPendingToolCalls === "function"
    && !!compat && "supportsAsyncTools" in compat && compat.supportsAsyncTools === true;
}

export function createToolLoader(
  pi: SearchAPI,
  getState: () => McpExtensionState | null,
  getInitPromise: () => Promise<McpExtensionState> | null,
  beforeExecute?: McpAdapterOptions["beforeExecute"],
) {
  const native = !!(pi.registerToolSearch && pi.getActiveToolReferences && pi.setActiveToolReferences);
  pi.registerEntryRenderer(ENTRY, () => undefined);
  const registered = new Map<string, { selection: Selection; ref: Reference; fingerprint: string; pinned: boolean }>();
  let available = new Set<string>();
  let selected = new Map<string, Selection>();
  let inactive = new Map<string, Selection>();
  let restoring = true;
  const active = (): Reference[] => native ? pi.getActiveToolReferences!() : pi.getActiveTools().map(name => ({ name }));
  const setActive = (refs: Reference[]) => {
    const unique = [...new Map(refs.map(ref => [refKey(ref), ref])).values()];
    if (JSON.stringify(active()) === JSON.stringify(unique)) return;
    if (native) pi.setActiveToolReferences!(unique);
    else pi.setActiveTools(unique.map(ref => ref.name));
  };
  function capture() {
    const current = new Set(active().map(refKey));
    for (const [id, { selection, ref, pinned }] of registered) {
      if (!available.has(id)) continue;
      if (current.has(refKey(ref))) { if (!pinned) selected.set(id, selection); inactive.delete(id); }
      else { selected.delete(id); if (pinned) inactive.set(id, selection); }
    }
  }
  function persist() {
    capture();
    pi.appendEntry(ENTRY, { selected: [...selected.values()], inactive: [...inactive.values()] });
  }
  function restore(ctx: ExtensionContext) {
    selected = new Map();
    inactive = new Map();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== ENTRY || !entry.data || typeof entry.data !== "object") continue;
      const data = entry.data as { selected?: Selection[]; inactive?: Selection[] };
      for (const [field, target] of [[data.selected, selected], [data.inactive, inactive]] as const) {
        target.clear();
        for (const selection of Array.isArray(field) ? field : []) {
          if (typeof selection?.server === "string" && typeof selection.tool === "string") target.set(key(selection), selection);
        }
      }
    }
    restoring = true;
  }
  function sync(config: McpConfig, cache: MetadataCache | null, env?: string[] | null, asyncSupported = false, registerGateways?: (pins: DirectToolSpec[]) => void) {
    if (!restoring) capture();
    const previousRefs = new Set([...registered.values()].map(item => refKey(item.ref)));
    const existing = new Set(pi.getAllTools().map(tool => refKey(tool)));
    const specs: Array<{ spec: DirectToolSpec; selection: Selection; ref: Reference; pinned: boolean }> = [];
    for (const [server, definition] of Object.entries(env === null ? {} : config.mcpServers)) {
      if (isServerDisabled(definition)) continue;
      const entry = cache?.servers[server];
      const metadata = getState()?.toolMetadata.get(server) ?? (entry && isServerCacheValid(entry, definition)
        ? reconstructToolMetadata(server, entry, config.settings?.toolPrefix ?? "server", definition) : []);
      const selection = directToolSelection(config, server, env ?? undefined);
      for (const { name: prefixedName, ...tool } of metadata) {
        if (tool.resourceUri) continue;
        const pinned = selection === true || (Array.isArray(selection) && selection.includes(tool.originalName));
        const ref = native && !pinned ? { namespace: `mcp_${server}`, name: tool.originalName } : { name: prefixedName };
        specs.push({ spec: { ...tool, prefixedName, serverName: server }, selection: { server, tool: tool.originalName }, ref, pinned });
      }
    }
    const counts = new Map<string, number>();
    for (const { ref } of specs) counts.set(refKey(ref), (counts.get(refKey(ref)) ?? 0) + 1);
    available = new Set();
    const enabled: Reference[] = [];
    for (const { spec, selection, ref, pinned } of specs) {
      const id = key(selection);
      const refId = refKey(ref);
      if ((!ref.namespace && reserved.has(ref.name)) || counts.get(refId)! > 1 || (existing.has(refId) && !previousRefs.has(refId))) continue;
      available.add(id);
      const asyncTool = asyncSupported && !beforeExecute && !spec.uiResourceUri && !isToolCallApprovalRequired(config, spec.serverName, spec);
      const fingerprint = JSON.stringify({ spec, ref, asyncTool });
      if (registered.get(id)?.fingerprint !== fingerprint) {
        pi.registerTool({
          ...ref,
          ...(asyncTool ? { async: true } : {}),
          ...(beforeExecute ? { executionMode: "sequential" as const } : {}),
          label: spec.title ?? `MCP: ${spec.originalName}`,
          description: spec.description || "(no description)",
          parameters: Type.Unsafe<Record<string, unknown>>(normalizeDirectToolInputSchema(spec.inputSchema)),
          execute: createDirectToolExecutor(getState, getInitPromise, spec, beforeExecute),
          renderCall: createMcpDirectToolCallRenderer(spec.prefixedName),
          renderResult: renderMcpToolResult,
        });
      }
      registered.set(id, { selection, ref, fingerprint, pinned });
      if (selected.has(id) || (pinned && !inactive.has(id))) enabled.push(ref);
    }
    const permitted = new Set(pi.getAllTools().map(refKey));
    const pins = specs.filter(item => item.pinned && available.has(key(item.selection)) && permitted.has(refKey(item.ref))).map(item => item.spec);
    registerGateways?.(pins);
    // Official 0.87 reactivates allowlisted definitions on registration. Apply our loadout last.
    const ownedRefs = new Set([...previousRefs, ...[...registered.values()].map(item => refKey(item.ref))]);
    setActive([...active().filter(ref => !ownedRefs.has(refKey(ref))), ...enabled]);
    restoring = false;
    return pins;
  }
  function activate(matches: Array<{ server: string; tool: ToolMetadata }>) {
    const requested = matches.flatMap(({ server, tool }) => {
      const id = key({ server, tool: tool.originalName });
      const registration = available.has(id) ? registered.get(id) : undefined;
      return registration ? [registration] : [];
    });
    // No await between reading and extending the current loadout: parallel searches union their selections.
    setActive([...active(), ...requested.map(item => item.ref)]);
    const current = new Set(active().map(refKey));
    const tools = requested.filter(item => current.has(refKey(item.ref))).map(({ selection, ref }) => {
      selected.set(key(selection), selection);
      return ref;
    });
    persist();
    return tools;
  }
  return { native, restore, sync, activate, persist, selectedServers: () => [...new Set([...selected.values()].map(item => item.server))] };
}
