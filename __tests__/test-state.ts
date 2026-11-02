import { ConsentManager } from "../consent-manager.ts";
import { McpLifecycleManager } from "../lifecycle.ts";
import { createOAuthRuntime } from "../mcp-oauth-runtime.ts";
import { McpServerManager } from "../server-manager.ts";
import { createMcpRuntimeOwner } from "../runtime-owner.ts";
import type { McpExtensionState } from "../state.ts";
import { UiResourceHandler } from "../ui-resource-handler.ts";

/**
 * Build a complete McpExtensionState for tests. Overrides must satisfy the
 * same field contracts as the production state.
 */
export function createTestState(overrides: Partial<McpExtensionState> = {}): McpExtensionState {
  const owner = overrides.owner ?? createMcpRuntimeOwner();
  const manager = overrides.manager ?? new McpServerManager();
  const state: McpExtensionState = {
    owner,
    manager,
    lifecycle: new McpLifecycleManager(manager),
    toolMetadata: new Map(),
    resourceCounts: new Map(),
    promptMetadata: new Map(),
    promptMetadataLive: new Set(),
    serverInstructions: new Map(),
    config: { mcpServers: {}, settings: {} },
    oauthRuntime: createOAuthRuntime(owner.signal),
    authStorageOptions: {},
    metadataCacheEnabled: false,
    failureTracker: new Map(),
    failureMessages: new Map(),
    approvedToolCalls: new Map(),
    uiResourceHandler: new UiResourceHandler(manager),
    consentManager: new ConsentManager(),
    uiServer: null,
    completedUiSessions: [],
    activeScripts: 0,
    openBrowser: async () => {
      // Test fixture has no external browser.
    },
    ...overrides,
  };
  return state;
}
