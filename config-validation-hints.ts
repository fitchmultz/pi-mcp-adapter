export type ValidationScope = "top" | "server" | "oauth" | "settings" | "outputGuard" | "trace";

export const CONFIG_POSITIVE_NUMERIC_FIELDS = new Set([
  "requestTimeoutMs",
  "lifetimeSeconds",
  "timeout",
]);

export const CONFIG_NON_NEGATIVE_NUMERIC_FIELDS = new Set([
  "idleTimeout",
  "maxBytes",
  "maxLines",
  "detailsMaxBytes",
  "maxEvents",
]);

export const CONFIG_TYPO_HINTS: Record<ValidationScope, Record<string, string>> = {
  top: {
    mcpServer: 'Did you mean "mcpServers"?',
    servers: 'Did you mean "mcpServers"?',
    directTool: 'Did you mean "settings.directTools"?',
    directTools: '"directTools" belongs under "settings" or individual servers, not at top level.',
    disable: '"disabled" belongs on individual entries under "mcpServers", not at top level.',
    disabled: '"disabled" belongs on individual entries under "mcpServers", not at top level.',
    timeout: '"requestTimeoutMs" belongs under "settings" or individual servers.',
  },
  server: {
    directTool: 'Did you mean "directTools"?',
    disable: 'Did you mean "disabled"?',
    enable: 'Use "disabled: false" instead of "enable".',
    timeout: 'Use "requestTimeoutMs" (ms) or "idleTimeout" (minutes) instead of "timeout".',
    includeTool: 'Did you mean "includeTools"?',
    excludeTool: 'Did you mean "excludeTools"?',
    approveTool: 'Did you mean "approveTools"?',
  },
  oauth: {},
  settings: {
    directTool: 'Did you mean "directTools"?',
    disable: '"disabled" belongs on individual server entries, not in "settings".',
    disabled: '"disabled" belongs on individual server entries, not in "settings".',
    timeout: 'Use "requestTimeoutMs" (ms) or "idleTimeout" (minutes) instead of "timeout".',
    approveTool: 'Did you mean "approveTools"?',
    imports: '"imports" belongs at the top level, not inside "settings".',
    mcpServers: '"mcpServers" belongs at the top level, not inside "settings".',
  },
  outputGuard: {},
  trace: {},
};
