import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { MetadataCache } from "./metadata-cache.ts";
import type { McpExtensionState } from "./state.ts";
import type { DirectToolSpec, McpAdapterOptions, McpConfig, ToolMetadata } from "./types.ts";
import {
  catalogDefinition,
  collectCatalog,
  type CatalogTool,
  type LoaderDependencies,
  type Selection,
} from "./tool-loader-catalog.ts";

const key = (value: Selection): string => JSON.stringify([value.server, value.tool]);
const reserved = new Set([
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "mcp",
  "mcp_script",
]);
type Registration = {
  name: string;
  fingerprint: string;
  definition: ReturnType<typeof catalogDefinition>;
  hidden: boolean;
};
interface ToolLoader {
  sync: (
    config: McpConfig,
    cache: MetadataCache | null,
    env?: string[] | null,
    registerGateways?: (pins: DirectToolSpec[]) => void,
  ) => DirectToolSpec[];
}

/**
 * Registers the MCP catalog with Pi. Pinned tools are direct and active from startup; every
 * other catalog tool registers with deferred exposure so Pi's native tool_search loads it and the
 * transcript owns which loaded tools survive resume, reload and branch navigation. Tools that leave
 * the catalog are re-registered hidden, since Pi cannot unregister a tool.
 */
class Loader implements ToolLoader {
  private readonly pi: ExtensionAPI;
  private readonly dependencies: LoaderDependencies;
  private readonly registered = new Map<string, Registration>();
  private readonly fingerprints = new WeakMap<
    ToolMetadata,
    { server: string; instructions: string | undefined; pinned: boolean; value: string }
  >();

  constructor(pi: ExtensionAPI, dependencies: LoaderDependencies) {
    this.pi = pi;
    this.dependencies = dependencies;
  }

  private register(item: CatalogTool, cache: MetadataCache | null): void {
    const { spec, selection, name, pinned } = item;
    const instructions =
      this.dependencies.getState()?.serverInstructions.get(spec.serverName) ??
      cache?.servers[spec.serverName]?.instructions;
    const fingerprint = this.fingerprint(item, instructions);
    const id = key(selection);
    const existing = this.registered.get(id);
    if (existing?.fingerprint === fingerprint && !existing.hidden) {
      return;
    }
    const definition = catalogDefinition(spec, instructions, this.dependencies, pinned);
    this.pi.registerTool(definition);
    this.registered.set(id, { name, fingerprint, definition, hidden: false });
  }

  private withdraw(available: Set<string>): void {
    for (const [id, registration] of this.registered) {
      if (available.has(id) || registration.hidden) {
        continue;
      }
      const hidden: ToolDefinition<
        ReturnType<typeof catalogDefinition>["parameters"],
        Record<string, unknown>
      > = { ...registration.definition, exposure: "hidden" };
      this.pi.registerTool(hidden);
      registration.hidden = true;
    }
  }

  private fingerprint(item: CatalogTool, instructions: string | undefined): string {
    const { spec, source, name, pinned } = item;
    const previous = Object.isFrozen(source) ? this.fingerprints.get(source) : undefined;
    const fingerprint =
      previous?.server === spec.serverName &&
      previous.instructions === instructions &&
      previous.pinned === pinned
        ? previous.value
        : JSON.stringify({ spec, name, instructions, pinned });
    if (Object.isFrozen(source)) {
      this.fingerprints.set(source, {
        server: spec.serverName,
        instructions,
        pinned,
        value: fingerprint,
      });
    }
    return fingerprint;
  }

  sync: ToolLoader["sync"] = (config, cache, env, registerGateways) => {
    const previousNames = new Set([...this.registered.values()].map((item) => item.name));
    const existing = new Set(this.pi.getAllTools().map((tool) => tool.name));
    const specs = collectCatalog(config, cache, env, this.dependencies.getState);
    const counts = new Map<string, number>();
    for (const { name } of specs) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const available = new Set<string>();
    for (const item of specs) {
      const { selection, name } = item;
      const foreign = existing.has(name) && !previousNames.has(name);
      if (reserved.has(name) || (counts.get(name) ?? 0) > 1 || foreign) {
        continue;
      }
      available.add(key(selection));
      this.register(item, cache);
    }
    this.withdraw(available);
    const permitted = new Set(this.pi.getAllTools().map((tool) => tool.name));
    const pins = specs
      .filter(
        (item) => item.pinned && available.has(key(item.selection)) && permitted.has(item.name),
      )
      .map((item) => item.spec);
    registerGateways?.(pins);
    return pins;
  };
}

export function createToolLoader(
  pi: ExtensionAPI,
  getState: () => McpExtensionState | null,
  getInitPromise: () => Promise<McpExtensionState> | null,
  beforeExecute?: McpAdapterOptions["beforeExecute"],
): ToolLoader {
  const loader = new Loader(pi, { getState, getInitPromise, beforeExecute });
  return { sync: loader.sync };
}
