import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { MetadataCache } from "./metadata-cache.ts";
import type { McpExtensionState } from "./state.ts";
import type { DirectToolSpec, McpAdapterOptions, McpConfig, ToolMetadata } from "./types.ts";
import { toolErrorOverride } from "./error-signal.ts";
import {
  catalogDefinition,
  collectCatalog,
  type CatalogTool,
  type LoaderDependencies,
  type Selection,
} from "./tool-loader-catalog.ts";
import {
  featureKeys,
  featureNames,
  isFeature,
  readToolSelection,
  TOOL_SELECTION_ENTRY,
  type Feature,
  type FeaturePolicy,
} from "./tool-loader-snapshots.ts";
export type { Feature, FeaturePolicy } from "./tool-loader-snapshots.ts";

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
  "mcp_search",
  "mcp_script",
]);
type Registration = { selection: Selection; name: string; fingerprint: string; pinned: boolean };
interface ToolLoader {
  registerFeature: <TParams extends TSchema, TDetails>(
    feature: Feature,
    definition: ToolDefinition<TParams, TDetails>,
  ) => void;
  restore: (ctx: ExtensionContext) => void;
  sync: (
    config: McpConfig,
    cache: MetadataCache | null,
    env?: string[] | null,
    registerGateways?: (pins: DirectToolSpec[]) => FeaturePolicy,
  ) => DirectToolSpec[];
  activate: (
    matches: Array<{ server: string; tool: ToolMetadata }>,
    enable?: Feature[],
  ) => Array<{ name: string }>;
  persist: () => void;
  selectedServers: () => string[];
}

class Loader implements ToolLoader {
  private readonly pi: ExtensionAPI;
  private readonly dependencies: LoaderDependencies;
  private readonly registered = new Map<string, Registration>();
  private readonly fingerprints = new WeakMap<
    ToolMetadata,
    { server: string; instructions: string | undefined; value: string }
  >();
  private available = new Set<string>();
  private selected = new Map<string, Selection>();
  private inactive = new Map<string, Selection>();
  private features: FeaturePolicy = {};
  private selectedFeatures = new Set<Feature>();
  private inactiveFeatures = new Set<Feature>();
  private readonly registeredFeatures = new Set<Feature>();
  private restoring = true;

  constructor(pi: ExtensionAPI, dependencies: LoaderDependencies) {
    this.pi = pi;
    this.dependencies = dependencies;
    pi.registerEntryRenderer(TOOL_SELECTION_ENTRY, () => {
      // Selection history is persisted for restoration, not displayed in the transcript.
    });
  }

  private setActive(names: string[]): void {
    const unique = [...new Set(names)];
    if (JSON.stringify(this.pi.getActiveTools()) !== JSON.stringify(unique)) {
      this.pi.setActiveTools(unique);
    }
  }

  registerFeature = <TParams extends TSchema, TDetails>(
    feature: Feature,
    definition: ToolDefinition<TParams, TDetails>,
  ): void => {
    this.pi.registerTool({
      defaultActive: false,
      ...definition,
      async execute(...args) {
        const result = await definition.execute(...args);
        return { ...result, ...toolErrorOverride(result.details) };
      },
    });
    this.registeredFeatures.add(feature);
  };

  private captureFeatures(current: Set<string>): void {
    for (const feature of featureKeys) {
      if (this.features[feature] === undefined) {
        continue;
      }
      if (current.has(featureNames[feature])) {
        if (this.features[feature].eager !== true) {
          this.selectedFeatures.add(feature);
        }
        this.inactiveFeatures.delete(feature);
      } else {
        this.selectedFeatures.delete(feature);
        if (this.features[feature].eager === true) {
          this.inactiveFeatures.add(feature);
        }
      }
    }
  }

  private capture(): void {
    const current = new Set(this.pi.getActiveTools());
    this.captureFeatures(current);
    for (const [id, { selection, name, pinned }] of this.registered) {
      if (!this.available.has(id)) {
        continue;
      }
      if (current.has(name)) {
        if (!pinned) {
          this.selected.set(id, selection);
        }
        this.inactive.delete(id);
      } else {
        this.selected.delete(id);
        if (pinned) {
          this.inactive.set(id, selection);
        }
      }
    }
  }

  persist = (): void => {
    this.capture();
    this.pi.appendEntry(TOOL_SELECTION_ENTRY, {
      selected: [...this.selected.values()],
      inactive: [...this.inactive.values()],
      features: [...this.selectedFeatures],
      inactiveFeatures: [...this.inactiveFeatures],
    });
  };

  restore = (ctx: ExtensionContext): void => {
    const data = readToolSelection(ctx) ?? {
      selected: [],
      inactive: [],
      features: [],
      inactiveFeatures: [],
    };
    this.selected = new Map(data.selected.map((selection) => [key(selection), selection]));
    this.inactive = new Map((data.inactive ?? []).map((selection) => [key(selection), selection]));
    this.selectedFeatures = new Set(data.features?.filter(isFeature) ?? []);
    this.inactiveFeatures = new Set(data.inactiveFeatures?.filter(isFeature) ?? []);
    this.restoring = true;
  };

  private register(item: CatalogTool, cache: MetadataCache | null): void {
    const { spec, selection, name, pinned } = item;
    const instructions =
      this.dependencies.getState()?.serverInstructions.get(spec.serverName) ??
      cache?.servers[spec.serverName]?.instructions;
    const fingerprint = this.fingerprint(item, instructions);
    const id = key(selection);
    if (this.registered.get(id)?.fingerprint !== fingerprint) {
      this.pi.registerTool(catalogDefinition(spec, instructions, this.dependencies));
    }
    this.registered.set(id, { selection, name, fingerprint, pinned });
  }

  private fingerprint(item: CatalogTool, instructions: string | undefined): string {
    const { spec, source, name } = item;
    const previous = Object.isFrozen(source) ? this.fingerprints.get(source) : undefined;
    const fingerprint =
      previous?.server === spec.serverName && previous.instructions === instructions
        ? previous.value
        : JSON.stringify({ spec, name, instructions });
    if (Object.isFrozen(source)) {
      this.fingerprints.set(source, { server: spec.serverName, instructions, value: fingerprint });
    }
    return fingerprint;
  }

  private syncTools(
    specs: CatalogTool[],
    cache: MetadataCache | null,
    previousNames: Set<string>,
  ): string[] {
    const existing = new Set(this.pi.getAllTools().map((tool) => tool.name));
    const counts = new Map<string, number>();
    for (const { name } of specs) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    this.available = new Set();
    const enabled: string[] = [];
    for (const item of specs) {
      const { selection, name, pinned } = item;
      const id = key(selection);
      if (
        reserved.has(name) ||
        (counts.get(name) ?? 0) > 1 ||
        this.isForeignName(name, existing, previousNames)
      ) {
        continue;
      }
      this.available.add(id);
      this.register(item, cache);
      if (this.isSelected(id, pinned)) {
        enabled.push(name);
      }
    }
    return enabled;
  }

  private isSelected(id: string, pinned: boolean): boolean {
    return this.selected.has(id) || (pinned && !this.inactive.has(id));
  }

  private isForeignName(name: string, existing: Set<string>, previousNames: Set<string>): boolean {
    return existing.has(name) && !previousNames.has(name);
  }

  private syncFeatures(policy: FeaturePolicy): string[] {
    const permitted = new Set(this.pi.getAllTools().map((tool) => tool.name));
    const loaderMissing = !permitted.has("mcp_search");
    const enabled: string[] = [];
    this.features = {};
    for (const feature of featureKeys) {
      const requested = policy[feature];
      if (requested && permitted.has(featureNames[feature])) {
        const eager = requested.eager === true || loaderMissing;
        this.features[feature] = { eager };
        if (this.selectedFeatures.has(feature) || (eager && !this.inactiveFeatures.has(feature))) {
          enabled.push(featureNames[feature]);
        }
      } else {
        this.selectedFeatures.delete(feature);
        this.inactiveFeatures.delete(feature);
      }
    }
    return enabled;
  }

  sync: ToolLoader["sync"] = (config, cache, env, registerGateways) => {
    if (!this.restoring) {
      this.capture();
    }
    const previousNames = new Set([...this.registered.values()].map((item) => item.name));
    const specs = collectCatalog(config, cache, env, this.dependencies.getState);
    const enabled = this.syncTools(specs, cache, previousNames);
    const permitted = new Set(this.pi.getAllTools().map((tool) => tool.name));
    const pins = specs
      .filter(
        (item) =>
          item.pinned && this.available.has(key(item.selection)) && permitted.has(item.name),
      )
      .map((item) => item.spec);
    const policy = registerGateways?.(pins);
    if (policy) {
      enabled.push(...this.syncFeatures(policy));
    }
    // Retain the journal: official 1.0 initial SDK resume has a native loadout restoration gap.
    const ownedNames = new Set([
      ...previousNames,
      ...[...this.registered.values()].map((item) => item.name),
    ]);
    for (const feature of this.registeredFeatures) {
      ownedNames.add(featureNames[feature]);
    }
    this.setActive([
      ...this.pi.getActiveTools().filter((name) => !ownedNames.has(name)),
      ...enabled,
    ]);
    this.restoring = false;
    return pins;
  };

  activate: ToolLoader["activate"] = (matches, enable = []) => {
    const requested = matches.flatMap(({ server, tool }) => {
      const id = key({ server, tool: tool.originalName });
      const registration = this.available.has(id) ? this.registered.get(id) : undefined;
      return registration ? [registration] : [];
    });
    // No await between reading and extending the current loadout: parallel searches union their selections.
    const permitted = new Set(this.pi.getAllTools().map((tool) => tool.name));
    const requestedFeatures = [...new Set(enable)].filter(
      (feature) => this.features[feature] !== undefined && permitted.has(featureNames[feature]),
    );
    this.setActive([
      ...this.pi.getActiveTools(),
      ...requested.map((item) => item.name),
      ...requestedFeatures.map((feature) => featureNames[feature]),
    ]);
    const current = new Set(this.pi.getActiveTools());
    const tools = requested
      .filter((item) => current.has(item.name))
      .map(({ selection, name }) => {
        this.selected.set(key(selection), selection);
        return { name };
      });
    for (const feature of requestedFeatures) {
      if (!current.has(featureNames[feature])) {
        continue;
      }
      this.selectedFeatures.add(feature);
      tools.push({ name: featureNames[feature] });
    }
    this.persist();
    return tools;
  };

  selectedServers = (): string[] => [
    ...new Set([...this.selected.values()].map((item) => item.server)),
  ];
}

export function createToolLoader(
  pi: ExtensionAPI,
  getState: () => McpExtensionState | null,
  getInitPromise: () => Promise<McpExtensionState> | null,
  beforeExecute?: McpAdapterOptions["beforeExecute"],
): ToolLoader {
  const loader = new Loader(pi, { getState, getInitPromise, beforeExecute });
  return {
    registerFeature: loader.registerFeature,
    restore: loader.restore,
    sync: loader.sync,
    activate: loader.activate,
    persist: loader.persist,
    selectedServers: loader.selectedServers,
  };
}
