import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { createDirectToolExecutor, directToolSelection } from "./direct-tools.ts";
import { isServerCacheValid, reconstructToolMetadata, type MetadataCache } from "./metadata-cache.ts";
import type { McpExtensionState } from "./state.ts";
import { createMcpDirectToolCallRenderer, renderMcpToolResult } from "./tool-result-renderer.ts";
import { isServerDisabled, type DirectToolSpec, type McpAdapterOptions, type McpConfig, type ToolMetadata } from "./types.ts";
import { normalizeDirectToolInputSchema } from "./utils.ts";
import { nativeMcpOutputSchema } from "./tool-registrar.ts";
import { toolErrorOverride } from "./error-signal.ts";

type Selection = { server: string; tool: string };
export type Feature = "gateway" | "script";
export type FeaturePolicy = Partial<Record<Feature, { eager?: boolean }>>;
const featureNames: Record<Feature, string> = { gateway: "mcp", script: "mcp_script" };
const ENTRY = "mcp-tool-selection";
const key = (value: Selection) => JSON.stringify([value.server, value.tool]);
const reserved = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls", "mcp", "mcp_search", "mcp_script"]);

export function createToolLoader(
  pi: ExtensionAPI,
  getState: () => McpExtensionState | null,
  getInitPromise: () => Promise<McpExtensionState> | null,
  beforeExecute?: McpAdapterOptions["beforeExecute"],
) {
  pi.registerEntryRenderer(ENTRY, () => undefined);
  const registered = new Map<string, { selection: Selection; name: string; fingerprint: string; pinned: boolean }>();
  let available = new Set<string>();
  let selected = new Map<string, Selection>();
  let inactive = new Map<string, Selection>();
  let features: FeaturePolicy = {};
  let selectedFeatures = new Set<Feature>();
  let inactiveFeatures = new Set<Feature>();
  const registeredFeatures = new Set<Feature>();
  let restoring = true;
  const active = () => pi.getActiveTools();
  const setActive = (names: string[]) => {
    const unique = [...new Set(names)];
    if (JSON.stringify(active()) === JSON.stringify(unique)) return;
    pi.setActiveTools(unique);
  };
  function registerFeature<TParams extends TSchema, TDetails>(feature: Feature, definition: ToolDefinition<TParams, TDetails>) {
    pi.registerTool({ defaultActive: false, ...definition, async execute(...args) {
      const result = await definition.execute(...args);
      return { ...result, ...toolErrorOverride(result.details) };
    } });
    registeredFeatures.add(feature);
  }
  function capture() {
    const current = new Set(active());
    for (const feature of Object.keys(features) as Feature[]) {
      if (current.has(featureNames[feature])) {
        if (!features[feature]?.eager) selectedFeatures.add(feature);
        inactiveFeatures.delete(feature);
      } else {
        selectedFeatures.delete(feature);
        if (features[feature]?.eager) inactiveFeatures.add(feature);
      }
    }
    for (const [id, { selection, name, pinned }] of registered) {
      if (!available.has(id)) continue;
      if (current.has(name)) { if (!pinned) selected.set(id, selection); inactive.delete(id); }
      else { selected.delete(id); if (pinned) inactive.set(id, selection); }
    }
  }
  function persist() {
    capture();
    pi.appendEntry(ENTRY, { selected: [...selected.values()], inactive: [...inactive.values()], features: [...selectedFeatures], inactiveFeatures: [...inactiveFeatures] });
  }
  function restore(ctx: ExtensionContext) {
    selected = new Map();
    inactive = new Map();
    selectedFeatures = new Set();
    inactiveFeatures = new Set();
    const manager = ctx.sessionManager;
    function* snapshots() {
      let id = manager.getLeafId();
      while (id) {
        const entry = manager.getEntry(id);
        if (!entry) break;
        yield entry;
        id = entry.parentId;
      }
    }
    for (const entry of snapshots()) {
      if (entry?.type !== "custom" || entry.customType !== ENTRY || !entry.data || typeof entry.data !== "object") continue;
      const data = entry.data as { selected?: Selection[]; inactive?: Selection[]; features?: Feature[]; inactiveFeatures?: Feature[] };
      if (!Array.isArray(data.selected) || [data.inactive, data.features, data.inactiveFeatures].some(value => value !== undefined && !Array.isArray(value))) continue;
      if ([...data.selected, ...(data.inactive ?? [])].some(value => !value || typeof value.server !== "string" || typeof value.tool !== "string")) continue;
      selectedFeatures = new Set(Array.isArray(data.features) ? data.features.filter(value => value === "gateway" || value === "script") : []);
      inactiveFeatures = new Set(Array.isArray(data.inactiveFeatures) ? data.inactiveFeatures.filter(value => value === "gateway" || value === "script") : []);
      for (const [field, target] of [[data.selected, selected], [data.inactive, inactive]] as const) {
        target.clear();
        for (const selection of Array.isArray(field) ? field : []) {
          if (typeof selection?.server === "string" && typeof selection.tool === "string") target.set(key(selection), selection);
        }
      }
      break;
    }
    restoring = true;
  }
  function sync(config: McpConfig, cache: MetadataCache | null, env?: string[] | null, registerGateways?: (pins: DirectToolSpec[]) => FeaturePolicy) {
    if (!restoring) capture();
    const previousNames = new Set([...registered.values()].map(item => item.name));
    const existing = new Set(pi.getAllTools().map(tool => tool.name));
    const specs: Array<{ spec: DirectToolSpec; selection: Selection; name: string; pinned: boolean }> = [];
    for (const [server, definition] of Object.entries(env === null ? {} : config.mcpServers)) {
      if (isServerDisabled(definition)) continue;
      const entry = cache?.servers[server];
      const metadata = getState()?.toolMetadata.get(server) ?? (entry && isServerCacheValid(entry, definition)
        ? reconstructToolMetadata(server, entry, config.settings?.toolPrefix ?? "server", definition) : []);
      const selection = directToolSelection(config, server, env ?? undefined);
      for (const { name: prefixedName, ...tool } of metadata) {
        if (tool.resourceUri) continue;
        const pinned = selection === true || (Array.isArray(selection) && selection.includes(tool.originalName));
        specs.push({ spec: { ...tool, prefixedName, serverName: server }, selection: { server, tool: tool.originalName }, name: prefixedName, pinned });
      }
    }
    const counts = new Map<string, number>();
    for (const { name } of specs) counts.set(name, (counts.get(name) ?? 0) + 1);
    available = new Set();
    const enabled: string[] = [];
    for (const { spec, selection, name, pinned } of specs) {
      const id = key(selection);
      if (reserved.has(name) || counts.get(name)! > 1 || (existing.has(name) && !previousNames.has(name))) continue;
      available.add(id);
      const instructions = getState()?.serverInstructions.get(spec.serverName) ?? cache?.servers[spec.serverName]?.instructions;
      const fingerprint = JSON.stringify({ spec, name, instructions });
      if (registered.get(id)?.fingerprint !== fingerprint) {
        pi.registerTool({
          name,
          namespace: { name: `mcp_${spec.serverName}`, ...(instructions !== undefined ? { instructions } : {}) },
          ...(spec.outputSchema ? { outputSchema: nativeMcpOutputSchema(spec.outputSchema) } : {}),
          ...(spec.annotations ? { annotations: {
            ...(typeof spec.annotations.readOnlyHint === "boolean" ? { readOnlyHint: spec.annotations.readOnlyHint } : {}),
            ...(typeof spec.annotations.destructiveHint === "boolean" ? { destructiveHint: spec.annotations.destructiveHint } : {}),
            ...(typeof spec.annotations.idempotentHint === "boolean" ? { idempotentHint: spec.annotations.idempotentHint } : {}),
            ...(typeof spec.annotations.openWorldHint === "boolean" ? { openWorldHint: spec.annotations.openWorldHint } : {}),
          } } : {}),
          // Inactive direct tools are not callable through codemode or nested execution.
          defaultActive: false,
          ...(beforeExecute ? { executionMode: "sequential" as const } : {}),
          label: spec.title ?? `MCP: ${spec.originalName}`,
          description: spec.description || "(no description)",
          parameters: Type.Unsafe<Record<string, unknown>>(normalizeDirectToolInputSchema(spec.inputSchema)),
          execute: createDirectToolExecutor(getState, getInitPromise, spec, beforeExecute),
          renderCall: createMcpDirectToolCallRenderer(spec.prefixedName),
          renderResult: renderMcpToolResult,
        });
      }
      registered.set(id, { selection, name, fingerprint, pinned });
      if (selected.has(id) || (pinned && !inactive.has(id))) enabled.push(name);
    }
    const permitted = new Set(pi.getAllTools().map(tool => tool.name));
    const pins = specs.filter(item => item.pinned && available.has(key(item.selection)) && permitted.has(item.name)).map(item => item.spec);
    const policy = registerGateways?.(pins);
    if (policy) {
      const permittedFeatures = new Set(pi.getAllTools().map(tool => tool.name));
      const loaderMissing = !permittedFeatures.has("mcp_search");
      features = {};
      for (const feature of Object.keys(featureNames) as Feature[]) {
        if (policy[feature] && permittedFeatures.has(featureNames[feature])) {
          features[feature] = { eager: policy[feature].eager || loaderMissing };
          if (selectedFeatures.has(feature) || (features[feature]?.eager && !inactiveFeatures.has(feature))) enabled.push(featureNames[feature]);
        } else {
          selectedFeatures.delete(feature);
          inactiveFeatures.delete(feature);
        }
      }
    }
    // Retain the journal: official 1.0 initial SDK resume has a native loadout restoration gap.
    const ownedNames = new Set([...previousNames, ...[...registered.values()].map(item => item.name)]);
    for (const feature of registeredFeatures) ownedNames.add(featureNames[feature]);
    setActive([...active().filter(name => !ownedNames.has(name)), ...enabled]);
    restoring = false;
    return pins;
  }
  function activate(matches: Array<{ server: string; tool: ToolMetadata }>, enable: Feature[] = []) {
    const requested = matches.flatMap(({ server, tool }) => {
      const id = key({ server, tool: tool.originalName });
      const registration = available.has(id) ? registered.get(id) : undefined;
      return registration ? [registration] : [];
    });
    // No await between reading and extending the current loadout: parallel searches union their selections.
    const permitted = new Set(pi.getAllTools().map(tool => tool.name));
    const requestedFeatures = [...new Set(enable)].filter(feature => features[feature] && permitted.has(featureNames[feature]));
    setActive([...active(), ...requested.map(item => item.name), ...requestedFeatures.map(feature => featureNames[feature])]);
    const current = new Set(active());
    const tools = requested.filter(item => current.has(item.name)).map(({ selection, name }) => {
      selected.set(key(selection), selection);
      return { name };
    });
    for (const feature of requestedFeatures) {
      if (!current.has(featureNames[feature])) continue;
      selectedFeatures.add(feature);
      tools.push({ name: featureNames[feature] });
    }
    persist();
    return tools;
  }
  return { registerFeature, restore, sync, activate, persist, selectedServers: () => [...new Set([...selected.values()].map(item => item.server))] };
}
