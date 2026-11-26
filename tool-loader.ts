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
  resolveCatalogNames,
  type CatalogTool,
  type LoaderDependencies,
  type Selection,
  type UnpinnedToolExposure,
} from "./tool-loader-catalog.ts";

const key = (value: Selection): string => JSON.stringify([value.server, value.tool]);
/**
 * How a registered tool is exposed to Pi: pinned and active from startup, deferred so tool_search
 * loads it, or withdrawn after it left the catalog. Pi cannot unregister a tool, so a withdrawn
 * one is re-registered hidden.
 */
type Exposure =
  | { kind: "pinned" }
  | { kind: "deferred" }
  | { kind: "codemode" }
  | {
      kind: "withdrawn";
      pinned: boolean;
      /** Whether the pin re-activates when it returns: active when it left, or still selected. */
      resumes: boolean;
    };

type Registration = {
  server: string;
  name: string;
  fingerprint: string;
  definition: ReturnType<typeof catalogDefinition>;
  exposure: Exposure;
};

interface ToolLoader {
  sync: (
    config: McpConfig,
    cache: MetadataCache | null,
    env?: string[] | null,
    registerGateways?: (pins: DirectToolSpec[]) => boolean | undefined,
  ) => DirectToolSpec[];
  /** Refresh non-active deferred catalog tools while keeping pinned and active tools frozen. */
  syncDeferred: (config: McpConfig, cache: MetadataCache | null, env?: string[] | null) => void;
  /** Whether any catalog tool is registered with deferred exposure. */
  hasDeferred: () => boolean;
  /** Decides every registered pin again after a session start or tree navigation. */
  settlePins: () => void;
  /** Server name owning a registered MCP tool name, if known. */
  serverForTool: (name: string) => string | undefined;
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
 * How re-registering a tool changes its pin; a first registration has no change. A pin the tool
 * already had counts again only when it resumes from withdrawal, so a deselection holds, and a
 * tool that was not pinned counts as gained because it gains a pin it never had.
 */
function pinChange(
  existing: Registration | undefined,
  pinned: boolean,
): "lost" | "gained" | undefined {
  if (existing === undefined) {
    return undefined;
  }
  const exposure = existing.exposure;
  const wasPinned =
    exposure.kind === "pinned" || (exposure.kind === "withdrawn" && exposure.pinned);
  if (wasPinned && !pinned) {
    return "lost";
  }
  const resumes = exposure.kind === "withdrawn" && exposure.resumes;
  return pinned && (!wasPinned || resumes) ? "gained" : undefined;
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
  private readonly ownedToolNames = new Set<string>();
  private readonly baseNames = new WeakMap<ToolMetadata, string>();
  private readonly toolToServer = new Map<string, string>();
  /** Pins decided since the last session boundary, so a later live deselection is not undone. */
  private readonly settled = new Set<string>();
  private readonly fingerprints = new WeakMap<
    ToolMetadata,
    {
      server: string;
      name: string;
      description: string | undefined;
      instructions: string | undefined;
      pinned: boolean;
      unpinnedExposure: UnpinnedToolExposure;
      value: string;
    }
  >();

  constructor(pi: ExtensionAPI, dependencies: LoaderDependencies) {
    this.pi = pi;
    this.dependencies = dependencies;
  }

  private hideRegistration(registration: Registration): void {
    const hidden: ToolDefinition<
      ReturnType<typeof catalogDefinition>["parameters"],
      Record<string, unknown>
    > = { ...registration.definition, exposure: "hidden" };
    this.pi.registerTool(hidden);
    if (this.toolToServer.get(registration.name) === registration.server) {
      this.toolToServer.delete(registration.name);
    }
  }

  private retireRenamed(
    existing: Registration,
    claimedNames: ReadonlySet<string>,
    active: ReadonlySet<string>,
  ): { lost?: string; wasActive: boolean } {
    const wasActive = active.has(existing.name);
    if (!claimedNames.has(existing.name)) {
      if (existing.exposure.kind !== "withdrawn") {
        this.hideRegistration(existing);
      }
      return { lost: existing.name, wasActive };
    }
    return { wasActive };
  }

  private instructionsFor(serverName: string, cache: MetadataCache | null): string | undefined {
    return (
      this.dependencies.getState()?.serverInstructions.get(serverName) ??
      cache?.servers[serverName]?.instructions
    );
  }

  /**
   * Reports a pin the tool lost, which Pi keeps active across re-registration, or one it gained or
   * regained active after withdrawal, which activates like a new pin within the session.
   */
  private register(
    item: CatalogTool,
    cache: MetadataCache | null,
    claimedNames: ReadonlySet<string>,
    active: ReadonlySet<string>,
  ): { lost?: string; gained?: string } {
    const { spec, selection, name, pinned, unpinnedExposure, description } = item;
    const instructions = this.instructionsFor(spec.serverName, cache);
    const fingerprint = this.fingerprint(item, instructions);
    const id = key(selection);
    const existing = this.registered.get(id);
    if (existing?.fingerprint === fingerprint && existing.exposure.kind !== "withdrawn") {
      return {};
    }
    const retired =
      existing !== undefined && existing.name !== name
        ? this.retireRenamed(existing, claimedNames, active)
        : undefined;
    const definition = catalogDefinition(spec, instructions, this.dependencies, {
      pinned,
      unpinnedExposure,
      description,
    });
    this.pi.registerTool(definition);
    this.ownedToolNames.add(name);
    this.registered.set(id, {
      server: selection.server,
      name,
      fingerprint,
      definition,
      exposure: pinned ? { kind: "pinned" } : { kind: unpinnedExposure },
    });
    this.toolToServer.set(name, selection.server);
    return this.pinTransition(existing, pinned, name, retired);
  }

  private pinTransition(
    existing: Registration | undefined,
    pinned: boolean,
    name: string,
    retired: { lost?: string; wasActive: boolean } | undefined,
  ): { lost?: string; gained?: string } {
    if (retired !== undefined) {
      const gained = pinned && (retired.wasActive || pinChange(existing, true) === "gained");
      return {
        ...(retired.lost !== undefined ? { lost: retired.lost } : {}),
        ...(gained ? { gained: name } : {}),
      };
    }
    const change = pinChange(existing, pinned);
    if (change === "lost") {
      return { lost: name };
    }
    return change === "gained" ? { gained: name } : {};
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
          item.exposure.kind === "pinned" &&
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

  private withdraw(available: Set<string>, freezePins: boolean): void {
    const active = new Set(this.pi.getActiveTools());
    for (const [id, registration] of this.registered) {
      if (available.has(id) || registration.exposure.kind === "withdrawn") {
        continue;
      }
      if (
        freezePins &&
        (registration.exposure.kind === "pinned" || active.has(registration.name))
      ) {
        continue;
      }
      registration.exposure = {
        kind: "withdrawn",
        pinned: registration.exposure.kind === "pinned",
        resumes: active.has(registration.name),
      };
      this.hideRegistration(registration);
    }
  }

  private fingerprint(item: CatalogTool, instructions: string | undefined): string {
    const { spec, source, name, pinned, unpinnedExposure, description } = item;
    const previous = Object.isFrozen(source) ? this.fingerprints.get(source) : undefined;
    const fingerprint =
      previous?.server === spec.serverName &&
      previous.name === name &&
      previous.description === description &&
      previous.instructions === instructions &&
      previous.pinned === pinned &&
      previous.unpinnedExposure === unpinnedExposure
        ? previous.value
        : JSON.stringify({ spec, name, description, instructions, pinned, unpinnedExposure });
    if (Object.isFrozen(source)) {
      this.fingerprints.set(source, {
        server: spec.serverName,
        name,
        description,
        instructions,
        pinned,
        unpinnedExposure,
        value: fingerprint,
      });
    }
    return fingerprint;
  }

  private baseCatalogItem(item: CatalogTool): CatalogTool {
    const baseName = this.baseNames.get(item.source);
    if (baseName === undefined || baseName === item.name) {
      return item;
    }
    return { ...item, name: baseName, spec: { ...item.spec, prefixedName: baseName } };
  }

  private resolveNames(rawSpecs: readonly CatalogTool[]): CatalogTool[] {
    const specs = rawSpecs.map((item) => this.baseCatalogItem(item));
    const foreign = new Set(
      this.pi
        .getAllTools()
        .map((tool) => tool.name)
        .filter((name) => !this.ownedToolNames.has(name)),
    );
    return resolveCatalogNames(specs, foreign);
  }

  /**
   * Write resolved public tool names back into `state.toolMetadata` so gateway search, describe,
   * and call match the exact names registered with Pi (and refresh MiniSearch via array replacement).
   */
  private syncMetadataNames(): void {
    const state = this.dependencies.getState();
    if (!state) {
      return;
    }
    for (const [server, tools] of state.toolMetadata) {
      const updated = this.rewriteServerMetadata(server, tools);
      if (updated !== undefined) {
        state.toolMetadata.set(server, updated);
      }
    }
  }

  private rewriteServerMetadata(server: string, tools: ToolMetadata[]): ToolMetadata[] | undefined {
    let changed = false;
    const next: ToolMetadata[] = [];
    for (const tool of tools) {
      const reg =
        (tool.resourceUri ?? "").length > 0
          ? undefined
          : this.registered.get(key({ server, tool: tool.originalName }));
      if (!reg || reg.exposure.kind === "withdrawn" || reg.name === tool.name) {
        next.push(tool);
        continue;
      }
      changed = true;
      const baseName = this.baseNames.get(tool) ?? tool.name;
      const cloned: ToolMetadata = { ...tool, name: reg.name };
      const finalTool = Object.isFrozen(tool) ? Object.freeze(cloned) : cloned;
      this.baseNames.set(finalTool, baseName);
      next.push(finalTool);
    }
    return changed ? next : undefined;
  }

  private isFrozenRegistration(item: CatalogTool, active: ReadonlySet<string>): boolean {
    if (item.pinned || active.has(item.name)) {
      return true;
    }
    const existing = this.registered.get(key(item.selection));
    return (
      existing?.exposure.kind === "pinned" || (existing !== undefined && active.has(existing.name))
    );
  }

  private syncDeferredOnly(resolved: readonly CatalogTool[], cache: MetadataCache | null): void {
    const active = new Set(this.pi.getActiveTools());
    const available = new Set(resolved.map((item) => key(item.selection)));
    const claimed = new Set(resolved.map((item) => item.name));
    const lost = new Set<string>();
    for (const item of resolved) {
      if (!this.isFrozenRegistration(item, active)) {
        const change = this.register(item, cache, claimed, active);
        if (change.lost !== undefined) {
          lost.add(change.lost);
        }
      }
    }
    this.withdraw(available, true);
    this.deactivate(lost);
    this.syncMetadataNames();
  }

  syncDeferred: ToolLoader["syncDeferred"] = (config, cache, env) => {
    const specs = collectCatalog(config, cache, env, this.dependencies.getState);
    this.syncDeferredOnly(this.resolveNames(specs), cache);
  };

  sync: ToolLoader["sync"] = (config, cache, env, registerGateways) => {
    const specs = collectCatalog(config, cache, env, this.dependencies.getState);
    const resolved = this.resolveNames(specs);
    const active = new Set(this.pi.getActiveTools());
    const available = new Set(resolved.map((item) => key(item.selection)));
    const claimed = new Set(resolved.map((item) => item.name));
    const lost = new Set<string>();
    const gained = new Set<string>();
    for (const item of resolved) {
      const change = this.register(item, cache, claimed, active);
      if (change.lost !== undefined) {
        lost.add(change.lost);
      }
      if (change.gained !== undefined) {
        gained.add(change.gained);
      }
    }
    this.withdraw(available, false);
    this.deactivate(lost);
    for (const name of lost) {
      this.settled.delete(name);
    }
    this.activatePins(gained);
    this.syncMetadataNames();
    const permitted = new Set(this.pi.getAllTools().map((tool) => tool.name));
    const pins = resolved
      .filter(
        (item) => item.pinned && available.has(key(item.selection)) && permitted.has(item.name),
      )
      .map((item) => item.spec);
    registerGateways?.(pins);
    return pins;
  };

  hasDeferred: ToolLoader["hasDeferred"] = () =>
    [...this.registered.values()].some((item) => item.exposure.kind === "deferred");

  settlePins: ToolLoader["settlePins"] = () => {
    this.settled.clear();
    for (const registration of this.registered.values()) {
      const exposure = registration.exposure;
      if (exposure.kind === "withdrawn" && exposure.pinned) {
        // Decided now: a prompt sent while the pin is withdrawn records it removed.
        exposure.resumes = this.dependencies.removedOnBranch?.(registration.name) !== true;
      }
    }
    this.activatePins(new Set());
  };

  serverForTool: ToolLoader["serverForTool"] = (name) => this.toolToServer.get(name);
}

export function createToolLoader(pi: ExtensionAPI, dependencies: LoaderDependencies): ToolLoader {
  const loader = new Loader(pi, dependencies);
  return {
    sync: loader.sync,
    syncDeferred: loader.syncDeferred,
    hasDeferred: loader.hasDeferred,
    settlePins: loader.settlePins,
    serverForTool: loader.serverForTool,
  };
}
