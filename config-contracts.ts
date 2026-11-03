import type { ServerEntry, HostConfigDiscovery, ImportKind } from "./config-types.ts";

export interface KnownServerPreset {
  id: string;
  name: string;
  summary: string;
  entry: ServerEntry;
}

export interface ConfigSourceSpec {
  id:
    | "shared-global"
    | "agents-global"
    | "agents-nested-global"
    | "pi-global"
    | "shared-project"
    | "pi-project";
  label: string;
  readPath: string;
  writePath: string;
  kind: "user" | "project" | "import";
  importKind?: string;
  shared: boolean;
  scope: "global" | "project";
}

export interface ConfigDiscoverySource {
  id: ConfigSourceSpec["id"];
  label: string;
  path: string;
  exists: boolean;
  scope: ConfigSourceSpec["scope"];
  kind: "shared" | "pi";
  serverCount: number;
}

export interface ImportConfigSummary {
  kind: ImportKind;
  path: string;
  serverCount: number;
}

export interface HostConfigSummary extends ImportConfigSummary {
  active: boolean;
}

export interface McpConfigConflict {
  serverName: string;
  sources: Array<{ kind: "shared" | "pi" | "host"; path: string }>;
  winner: { kind: "shared" | "pi" | "host"; path: string };
}

export interface RepoPromptDiscovery {
  configured: boolean;
  configuredPath?: string;
  executablePath?: string;
  targetPath?: string;
  serverName?: string;
  entry?: ServerEntry;
}

export interface McpDiscoverySummary {
  sources: ConfigDiscoverySource[];
  imports: ImportConfigSummary[];
  hostConfigs: HostConfigSummary[];
  hostConfigDiscovery: HostConfigDiscovery;
  conflicts: McpConfigConflict[];
  hasAnyConfig: boolean;
  hasAnyDetectedPaths: boolean;
  hasSharedServers: boolean;
  hasPiOwnedServers: boolean;
  totalServerCount: number;
  repoPrompt: RepoPromptDiscovery;
}

export interface ConfigWritePreview {
  path: string;
  existed: boolean;
  changed: boolean;
  beforeText: string;
  afterText: string;
  diffText: string;
}

export interface LoadMcpConfigOptions {
  includeProject?: boolean;
}

export interface ServerDisabledOverrideResult {
  path: string;
  changed: boolean;
}
