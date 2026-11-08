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
  /**
   * Whether a withdrawn pin re-activates on return: it was active when it left, or a later session
   * boundary reached a branch that did not record removing it.
   */
  activeWhenWithdrawn: boolean;
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
  /** Decides every registered pin again after a session start or tree navigation. */
  settlePins: () => void;
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
 * How re-registering a tool changes its pin; a first registration has no change. A pin returning
 * from withdrawal counts as gained only if `activeWhenWithdrawn`, so a deselection holds.
 */
function pinChange(
  existing: Registration | undefined,
  pinned: boolean,
): "lost" | "gained" | undefined {
  if (existing === undefined) {
    return undefined;
  }
  if (existing.pinned && !pinned) {
    return "lost";
  }
  return pinned && (!existing.pinned || (existing.hidden && existing.activeWhenWithdrawn))
    ? "gained"
    : undefined;
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
  /** Pins decided since the last session boundary, so a later live deselection is not undone. */
  private readonly settled = new Set<string>();
  private readonly fingerprints = new WeakMap<
    ToolMetadata,
    { server: string; instructions: string | undefined; pinned: boolean; value: string }
  >();

  constructor(pi: ExtensionAPI, dependencies: LoaderDependencies) {
    this.pi = pi;
    this.dependencies = dependencies;
  }

  /**
   * Reports a pin the tool lost, which Pi keeps active across re-registration, or one it gained or
   * regained active after withdrawal, which activates like a new pin within the session.
   */
  private register(item: CatalogTool, cache: MetadataCache | null): "lost" | "gained" | undefined {
    const { spec, selection, name, pinned } = item;
    const instructions =
      this.dependencies.getState()?.serverInstructions.get(spec.serverName) ??
      cache?.servers[spec.serverName]?.instructions;
    const fingerprint = this.fingerprint(item, instructions);
    const id = key(selection);
    const existing = this.registered.get(id);
    if (existing?.fingerprint === fingerprint && !existing.hidden) {
      return undefined;
    }
    const definition = catalogDefinition(spec, instructions, this.dependencies, pinned);
    this.pi.registerTool(definition);
    this.registered.set(id, {
      name,
      fingerprint,
      definition,
      hidden: false,
      pinned,
      activeWhenWithdrawn: false,
    });
    return pinChange(existing, pinned);
  }

  /**
   * Pins register with `defaultActive: false`, so Pi activates one itself only when the session
   * names it (a `tools` allowlist or `+name`) or restores it from the branch's recorded loadout.
   * Each other pin is activated once per session boundary unless the branch recorded removing it,
   * as Pi keeps a recorded removal; `gained` pins activate regardless.
   */
  private activatePins(gained: ReadonlySet<string>): void {
    const registered = new Set(this.pi.getAllTools().map((tool) => tool.name));
    const pins = [...this.registered.values()]
      .filter(
        (item) =>
          item.pinned &&
          !item.hidden &&
          registered.has(item.name) &&
          (gained.has(item.name) || !this.settled.has(item.name)),
      )
      .map((item) => item.name);
    const active = this.pi.getActiveTools();
    const activate = pins.filter(
      (name) =>
        !active.includes(name) &&
        (gained.has(name) || this.dependencies.removedOnBranch?.(name) !== true),
    );
    for (const name of pins) {
      this.settled.add(name);
    }
    if (activate.length > 0) {
      this.pi.setActiveTools([...active, ...activate]);
    }
  }

  private deactivate(names: ReadonlySet<string>): void {
    const active = this.pi.getActiveTools();
    if (active.some((name) => names.has(name))) {
      this.pi.setActiveTools(active.filter((name) => !names.has(name)));
    }
  }

  private withdraw(available: Set<string>): void {
    const active = new Set(this.pi.getActiveTools());
    for (const [id, registration] of this.registered) {
      if (available.has(id) || registration.hidden) {
        continue;
      }
      registration.activeWhenWithdrawn = active.has(registration.name);
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
    const lost = new Set<string>();
    const gained = new Set<string>();
    for (const item of eligible) {
      const change = this.register(item, cache);
      if (change !== undefined) {
        (change === "lost" ? lost : gained).add(item.name);
      }
    }
    this.withdraw(available);
    this.deactivate(lost);
    for (const name of lost) {
      this.settled.delete(name);
    }
    this.activatePins(gained);
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

  settlePins: ToolLoader["settlePins"] = () => {
    this.settled.clear();
    for (const registration of this.registered.values()) {
      if (registration.hidden && registration.pinned) {
        // Decided now: a prompt sent while the pin is withdrawn records it removed.
        registration.activeWhenWithdrawn =
          this.dependencies.removedOnBranch?.(registration.name) !== true;
      }
    }
    this.activatePins(new Set());
  };
}

export function createToolLoader(pi: ExtensionAPI, dependencies: LoaderDependencies): ToolLoader {
  const loader = new Loader(pi, dependencies);
  return { sync: loader.sync, hasDeferred: loader.hasDeferred, settlePins: loader.settlePins };
}
