import type {
  HostConfigDiscovery,
  ImportKind,
  McpConfig,
  McpConfigValidationError,
  ServerEntry,
} from "./config-types.ts";
import type { ServerProvenance } from "./types.ts";

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
    | "native-pi-global"
    | "pi-global"
    | "shared-project"
    | "native-pi-project"
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
  /** Whether to read Pi's native `<agentDir>/mcp.json` and `<project>/.pi/mcp.json`. Defaults to true; set false when `builtin:mcp` is active. */
  includeNativePi?: boolean;
  /** Whether to read Pi's native `<project>/.pi/mcp.json`. Defaults to true; set false when `builtin:mcp` is active. */
  includeNativePiProject?: boolean;
}

export interface ServerDisabledOverrideResult {
  path: string;
  changed: boolean;
}

export interface ConfigSourceReport {
  id: string;
  label: string;
  path: string;
  kind: "override" | "project" | "user" | "import" | "host";
  scope: "global" | "project" | "override";
  status: "loaded" | "missing" | "blocked" | "excluded" | "error";
  serverCount: number;
  importKind?: ImportKind;
  blockedReason?: string;
  excludedReason?: string;
}

export interface BlockedServerInfo {
  name: string;
  sourcePath: string;
  reason: string;
}

export interface McpConfigSnapshot {
  config: McpConfig;
  provenance: Map<string, ServerProvenance>;
  discoverySummary: McpDiscoverySummary;
  errors: McpConfigValidationError[];
  sources: ConfigSourceReport[];
  blockedServers: BlockedServerInfo[];
}
