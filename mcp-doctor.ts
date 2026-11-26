import { existsSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import { inspectMcpConfigSnapshot, type LoadMcpConfigOptions } from "./config.ts";
import { getDefaultMcpLogPath } from "./mcp-log.ts";
import { getAuthBaseDir, inspectAuthForUrl } from "./mcp-auth.ts";
import { authEligibility } from "./mcp-auth-commands.ts";
import { isProcessLocalAuthStore } from "./keyring-store.ts";
import { getFailureAgeSeconds, getFailureMessage } from "./init.ts";
import {
  failureAgeSeconds,
  inspectionStatus,
  serverFailureBackoffMs,
  serverStage,
} from "./server-status.ts";
import { isServerDisabled, type McpConfigValidationError, type ServerEntry } from "./types.ts";
import { resolveServerUrl, sanitizeTerminalText } from "./utils.ts";

export interface DoctorOptions {
  readonly configOverridePath?: string | undefined;
  readonly discoveryOptions?:
    | Pick<LoadMcpConfigOptions, "includeNativePi" | "includeNativePiProject">
    | undefined;
}

function mergeValidationErrors(
  stateErrors: readonly McpConfigValidationError[] | undefined,
  snapshotErrors: readonly McpConfigValidationError[],
): McpConfigValidationError[] {
  const seen = new Set<string>();
  const combined: McpConfigValidationError[] = [];
  for (const error of [...(stateErrors ?? []), ...snapshotErrors]) {
    const key = `${error.severity}\0${error.kind}\0${error.filePath}\0${error.serverName ?? ""}\0${error.field ?? ""}\0${error.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      combined.push(error);
    }
  }
  return combined;
}

function formatTransportSummary(entry: ServerEntry): string {
  if (typeof entry.url === "string" && entry.url.length > 0) {
    return entry.url;
  }
  if (typeof entry.socket === "string" && entry.socket.length > 0) {
    return `unix://${entry.socket}`;
  }
  if (typeof entry.command === "string" && entry.command.length > 0) {
    return [entry.command, ...(entry.args ?? [])].join(" ");
  }
  return "override/unspecified";
}

async function formatStoredCredentialStatus(
  state: McpExtensionState,
  name: string,
  url: string,
): Promise<string> {
  const status = await inspectAuthForUrl(
    { serverName: name, serverUrl: url },
    state.authStorageOptions,
  );
  if (status.status === "unavailable") {
    return `  • ${name}: keyring error — ${sanitizeTerminalText(status.message)}`;
  }
  if (status.status === "absent" || !status.entry.tokens) {
    return `  • ${name}: unauthenticated (run /mcp-auth ${name})`;
  }
  const expiresAt = status.entry.tokens.expiresAt;
  if (typeof expiresAt === "number" && expiresAt <= Date.now()) {
    return `  • ${name}: stored OAuth token expired (refresh/re-auth may be required)`;
  }
  return `  • ${name}: authenticated`;
}

async function formatCredentialHealthLine(
  state: McpExtensionState,
  name: string,
  entry: ServerEntry,
): Promise<string> {
  if (authEligibility(entry) !== "eligible") {
    return `  • ${name}: ${entry.auth === "bearer" ? "bearer token auth" : "non-OAuth"}`;
  }
  let url: string | undefined;
  try {
    url = resolveServerUrl(entry);
  } catch (error) {
    const reason = sanitizeTerminalText(error instanceof Error ? error.message : String(error));
    return `  • ${name}: invalid URL (${reason})`;
  }
  if (url === undefined || url.length === 0) {
    return `  • ${name}: OAuth URL unavailable`;
  }
  return formatStoredCredentialStatus(state, name, url);
}

function appendValidationErrorsSection(
  lines: string[],
  errors: readonly McpConfigValidationError[],
): void {
  lines.push(
    errors.length === 0 ? "Config Validation: none" : `Config Validation (${errors.length}):`,
  );
  for (const err of errors) {
    const scope = [err.serverName, err.field].filter(Boolean).join(".");
    const loc = scope.length > 0 ? `${err.filePath} (${scope})` : err.filePath;
    lines.push(`  • [${err.severity}] ${loc}: ${err.message}`);
  }
}

function appendConfigSourcesSection(
  lines: string[],
  sources: ReturnType<typeof inspectMcpConfigSnapshot>["sources"],
): void {
  const activeSources = sources.filter((source) => source.status !== "missing");
  lines.push("Config Sources:");
  if (activeSources.length === 0) {
    lines.push("  • none detected");
    return;
  }
  for (const source of activeSources) {
    const detail =
      source.status === "blocked"
        ? `blocked (${source.blockedReason ?? "untrusted project"})`
        : `${source.status}, ${source.serverCount} server(s)`;
    lines.push(`  • [${source.scope}] ${source.path} — ${detail}`);
  }
}

function appendProvenanceSection(
  lines: string[],
  snapshot: ReturnType<typeof inspectMcpConfigSnapshot>,
  state: McpExtensionState,
  targetServer: string | undefined,
): void {
  const serverNames =
    targetServer !== undefined && targetServer.length > 0
      ? [targetServer]
      : Object.keys(state.config.mcpServers);
  if (serverNames.length === 0 || snapshot.provenance.size === 0) {
    return;
  }
  lines.push("Server Provenance:");
  for (const name of serverNames) {
    const prov = snapshot.provenance.get(name);
    if (!prov) {
      continue;
    }
    const via = prov.importKind !== undefined ? `${prov.kind}/${prov.importKind}` : prov.kind;
    lines.push(`  • ${name}: ${prov.path} (${via})`);
  }
}

function appendConfigSections(
  lines: string[],
  state: McpExtensionState,
  ctx: ExtensionContext,
  input: { options: DoctorOptions; targetServer: string | undefined },
): ReturnType<typeof inspectMcpConfigSnapshot> | undefined {
  const { options, targetServer } = input;
  if (state.programmaticConfig === true) {
    lines.push("Config Sources: in-memory programmatic config (file discovery disabled)");
    appendValidationErrorsSection(lines, state.configErrors ?? []);
    return undefined;
  }

  const snapshot = inspectMcpConfigSnapshot(
    options.configOverridePath ?? state.configPath,
    ctx.cwd,
    { ...options.discoveryOptions, includeProject: ctx.isProjectTrusted() },
  );
  appendConfigSourcesSection(lines, snapshot.sources);
  appendProvenanceSection(lines, snapshot, state, targetServer);
  appendValidationErrorsSection(lines, mergeValidationErrors(state.configErrors, snapshot.errors));
  return snapshot;
}

function readServerStderrTail(state: McpExtensionState, name: string): string {
  try {
    const live = state.manager.getStderrTail(name);
    if (live.length > 0) {
      return live;
    }
  } catch {
    // Fall back to remembered stderr when a mocked manager omits getStderrTail.
  }
  return state.recentStderr?.get(name) ?? "";
}

function formatDoctorServerLine(
  state: McpExtensionState,
  name: string,
  entry: ServerEntry,
): string {
  const failedAgo = getFailureAgeSeconds(state, name);
  const stage = serverStage({
    definition: entry,
    transport: state.manager.getConnection(name)?.status,
    failedAgoSeconds: failedAgo,
    catalogKnown: state.toolMetadata.has(name),
  });
  const info = inspectionStatus(stage, failedAgo, getFailureMessage(state, name));
  const tools =
    state.toolMetadata.get(name)?.filter((tool) => tool.resourceUri === undefined).length ?? 0;
  const suffix = info.failed || stage === "disabled" ? "" : ` (${tools} tools)`;
  const transport = sanitizeTerminalText(formatTransportSummary(entry));
  return `  ${info.statusIcon} ${name}: ${info.status}${suffix} [${transport}]`;
}

function matchesTargetServer(name: string, targetServer: string | undefined): boolean {
  return targetServer === undefined || targetServer.length === 0 || name === targetServer;
}

function appendRecentStderrSection(
  lines: string[],
  state: McpExtensionState,
  configuredNames: readonly string[],
): void {
  const stderrEntries = configuredNames
    .map((name) => ({ name, tail: readServerStderrTail(state, name) }))
    .filter((entry) => entry.tail.length > 0);
  lines.push(stderrEntries.length === 0 ? "Recent Stderr: none" : "Recent Stderr:");
  for (const { name, tail } of stderrEntries) {
    const indented = sanitizeTerminalText(tail).replace(/\n/g, "\n    ");
    lines.push(`  • ${name}:\n    ${indented}`);
  }
}

function appendServerAndStderrSections(
  lines: string[],
  state: McpExtensionState,
  snapshot: ReturnType<typeof inspectMcpConfigSnapshot> | undefined,
  targetServer: string | undefined,
): void {
  const configuredNames = Object.keys(state.config.mcpServers).filter((name) =>
    matchesTargetServer(name, targetServer),
  );
  const blocked = (snapshot?.blockedServers ?? []).filter(
    (entry) =>
      !(entry.name in state.config.mcpServers) && matchesTargetServer(entry.name, targetServer),
  );

  lines.push("Servers:");
  if (configuredNames.length === 0 && blocked.length === 0) {
    lines.push("  • none configured");
  }
  for (const name of configuredNames) {
    const entry = state.config.mcpServers[name];
    if (entry) {
      lines.push(formatDoctorServerLine(state, name, entry));
    }
  }
  for (const entry of blocked) {
    lines.push(`  ⊘ ${entry.name}: blocked — ${entry.reason} (${entry.sourcePath})`);
  }

  const logPath = getDefaultMcpLogPath();
  lines.push(`Server Log: ${logPath} (${existsSync(logPath) ? "present" : "not created"})`);
  appendRecentStderrSection(lines, state, configuredNames);
}

async function appendCredentialHealthSection(
  lines: string[],
  state: McpExtensionState,
  targetServer: string | undefined,
): Promise<void> {
  const oauthDir = getAuthBaseDir(state.authStorageOptions);
  const testStore = process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE ?? "";
  const storeMode = isProcessLocalAuthStore() ? `process-local (${testStore})` : "OS keyring";
  lines.push(`OAuth / Keyring Health (${storeMode}, dir: ${oauthDir}):`);
  const urlServers = Object.entries(state.config.mcpServers).filter(
    ([name, entry]) => !isServerDisabled(entry) && matchesTargetServer(name, targetServer),
  );
  if (urlServers.length === 0) {
    lines.push("  • no active servers to inspect");
    return;
  }
  const healthLines = await Promise.all(
    urlServers.map(([name, entry]) => formatCredentialHealthLine(state, name, entry)),
  );
  lines.push(...healthLines);
}

function hasDoctorFailures(
  state: McpExtensionState,
  snapshot: ReturnType<typeof inspectMcpConfigSnapshot> | undefined,
): boolean {
  const hasStateErrors = state.configErrors?.some((err) => err.severity === "error") ?? false;
  const hasSnapshotErrors = snapshot?.errors.some((err) => err.severity === "error") ?? false;
  if (hasStateErrors || hasSnapshotErrors) {
    return true;
  }
  return Object.keys(state.config.mcpServers).some(
    (name) =>
      failureAgeSeconds(
        state.failureTracker.get(name),
        Date.now(),
        serverFailureBackoffMs(state, name),
      ) !== null,
  );
}

export async function showDoctor(
  state: McpExtensionState,
  ctx: ExtensionContext,
  options: DoctorOptions = {},
  targetServer?: string,
): Promise<void> {
  if (!ctx.hasUI) {
    return;
  }
  if (
    targetServer !== undefined &&
    targetServer.length > 0 &&
    !state.config.mcpServers[targetServer]
  ) {
    ctx.ui.notify(`Server "${targetServer}" not found in config`, "error");
    return;
  }

  const lines: string[] = ["MCP Doctor:", ""];
  const snapshot = appendConfigSections(lines, state, ctx, { options, targetServer });
  lines.push("");
  await appendCredentialHealthSection(lines, state, targetServer);
  lines.push("");
  appendServerAndStderrSections(lines, state, snapshot, targetServer);
  ctx.ui.notify(lines.join("\n"), hasDoctorFailures(state, snapshot) ? "warning" : "info");
}
