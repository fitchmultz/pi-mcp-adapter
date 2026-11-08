import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { MetadataCache } from "./metadata-cache.ts";
import type { DirectToolSpec, McpConfig, ToolMetadata } from "./types.ts";
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
  pinned: boolean;
};
interface ToolLoader {
  sync: (
    config: McpConfig,
    cache: MetadataCache | null,
    env?: string[] | null,
    registerGateways?: (pins: DirectToolSpec[]) => void,
  ) => DirectToolSpec[];
  /** Whether any catalog tool is registered with deferred exposure. */
  hasDeferred: () => boolean;
}

/** Replays the branch's recorded tool loadout (Pi docs/session-format.md) for one tool. */
export function removedOnBranch(
  manager: ExtensionContext["sessionManager"],
  name: string,
): boolean {
  let removed = false;
  for (const entry of manager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "system") {
      continue;
    }
    if (entry.message.toolsRemoved?.some((tool) => tool.name === name) === true) {
      removed = true;
    }
    if (entry.message.toolsAdded?.some((tool) => tool.name === name) === true) {
      removed = false;
    }
  }
  return removed;
}

/**
 * Pi's own MCP extension activates tool_search when it registers deferred tools, since only
 * tool_search can declare them. Only a registered tool_search that reaches other tools qualifies,
 * and a branch that recorded removing it keeps it off, as Pi keeps any recorded removal.
 * Returns whether the decision is made: false only while no such tool_search is registered.
 */
export function activateToolSearch(
  pi: ExtensionAPI,
  manager: ExtensionContext["sessionManager"] | undefined,
): boolean {
  if (
    !pi.getAllTools().some((tool) => tool.name === "tool_search" && tool.reachesTools !== undefined)
  ) {
    return false;
  }
  const active = pi.getActiveTools();
  if (
    !active.includes("tool_search") &&
    (manager === undefined || !removedOnBranch(manager, "tool_search"))
  ) {
    pi.setActiveTools([...active, "tool_search"]);
  }
  return true;
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

  /** Returns whether the tool must leave the active set. */
  private register(item: CatalogTool, cache: MetadataCache | null): boolean {
    const { spec, selection, name, pinned } = item;
    const instructions =
      this.dependencies.getState()?.serverInstructions.get(spec.serverName) ??
      cache?.servers[spec.serverName]?.instructions;
    const fingerprint = this.fingerprint(item, instructions);
    const id = key(selection);
    const existing = this.registered.get(id);
    if (existing?.fingerprint === fingerprint && !existing.hidden) {
      return false;
    }
    const definition = catalogDefinition(spec, instructions, this.dependencies, pinned);
    this.pi.registerTool(definition);
    this.registered.set(id, { name, fingerprint, definition, hidden: false, pinned });
    return this.leavesActiveSet(item, existing);
  }

  /**
   * Pi keeps a lost pin active across re-registration, and activates a pin registered after it
   * restored the branch even when the branch removed it. A withdrawn pin that returns stays active,
   * as Pi activates it like a new tool.
   */
  private leavesActiveSet(item: CatalogTool, existing: Registration | undefined): boolean {
    if (!item.pinned) {
      return existing?.pinned === true;
    }
    return existing === undefined && this.dependencies.removedOnBranch?.(item.name) === true;
  }

  private deactivate(names: ReadonlySet<string>): void {
    const active = this.pi.getActiveTools();
    if (active.some((name) => names.has(name))) {
      this.pi.setActiveTools(active.filter((name) => !names.has(name)));
    }
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

  /** Catalog tools this loader may own: unique, unreserved, and not registered by another extension. */
  private eligible(specs: readonly CatalogTool[]): CatalogTool[] {
    const previousNames = new Set([...this.registered.values()].map((item) => item.name));
    const existing = new Set(this.pi.getAllTools().map((tool) => tool.name));
    const counts = new Map<string, number>();
    for (const { name } of specs) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return specs.filter(
      ({ name }) =>
        !reserved.has(name) &&
        counts.get(name) === 1 &&
        (!existing.has(name) || previousNames.has(name)),
    );
  }

  sync: ToolLoader["sync"] = (config, cache, env, registerGateways) => {
    const specs = collectCatalog(config, cache, env, this.dependencies.getState);
    const eligible = this.eligible(specs);
    const available = new Set(eligible.map((item) => key(item.selection)));
    const inactive = new Set(
      eligible.filter((item) => this.register(item, cache)).map((item) => item.name),
    );
    this.withdraw(available);
    this.deactivate(inactive);
    const permitted = new Set(this.pi.getAllTools().map((tool) => tool.name));
    const pins = specs
      .filter(
        (item) => item.pinned && available.has(key(item.selection)) && permitted.has(item.name),
      )
      .map((item) => item.spec);
    registerGateways?.(pins);
    return pins;
  };

  hasDeferred: ToolLoader["hasDeferred"] = () =>
    [...this.registered.values()].some((item) => !item.hidden && !item.pinned);
}

export function createToolLoader(pi: ExtensionAPI, dependencies: LoaderDependencies): ToolLoader {
  const loader = new Loader(pi, dependencies);
  return { sync: loader.sync, hasDeferred: loader.hasDeferred };
}
