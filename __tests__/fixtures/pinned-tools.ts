import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createToolLoader } from "../../tool-loader.ts";
import type { McpConfig, MetadataCache, ToolPrefix } from "../../types.ts";

/** Exercise pin projection through the registered tool surface. */
export function resolvePinnedTools(config: McpConfig, cache: MetadataCache | null, prefix: ToolPrefix, env?: string[]) {
  const tools = new Map<string, ToolDefinition>();
  let active: string[] = [];
  const pi = {
    registerEntryRenderer() {},
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); active.push(tool.name); },
    getAllTools: () => [...tools.values()],
    getActiveTools: () => active,
    setActiveTools(names: string[]) { active = names; },
  } as unknown as ExtensionAPI;
  return createToolLoader(pi, () => null, () => null).sync({ ...config, settings: { ...config.settings, toolPrefix: prefix } }, cache, env);
}
