// Import sources for config
export type ImportKind =
  | "cursor"
  | "claude-code"
  | "claude-desktop"
  | "codex"
  | "opencode"
  | "windsurf"
  | "vscode";

/** Native private_key_jwt authentication; public verification keys are provisioned separately. */
export interface OAuthPrivateKeyJwtConfig {
  /** PKCS#8 PEM, JWK object/JSON, or an existing environment/!command source. Resolved only when signing. */
  privateKey: string | Record<string, unknown>;
  /** Asymmetric JOSE algorithm, such as ES256, RS256, PS256 or EdDSA (JWK only). */
  algorithm: string;
  /** JWT audience override only; defaults to the discovered issuer, then token URL. */
  audience?: string;
  /** Positive integer assertion lifetime in seconds; native default is 300. */
  lifetimeSeconds?: number;
  /** Additional claims. Native iss/sub/aud/iat/exp/jti always take precedence. */
  claims?: Record<string, unknown>;
}

/** Enterprise OIDC token exchange. IdP credentials are separate from the MCP client identity. */
export interface OAuthCrossAppAccessConfig {
  /** IdP issuer used by native discovery. */
  idpUrl: string;
  /** IdP client ID, not the outer MCP clientId. */
  clientId: string;
  /** Existing OIDC ID token; environment/!command sources are resolved for each exchange. */
  idToken: string;
  /** Optional IdP client_secret_post credential, also resolved lazily. */
  clientSecret?: string;
}

// OAuth configuration (SDK handles discovery and client registration)
export interface OAuthConfig {
  /** Skip only authorization-server metadata issuer validation. Defaults to false. */
  skipIssuerMetadataValidation?: boolean;
  /** OAuth grant type (defaults to authorization_code) */
  grantType?: "authorization_code" | "client_credentials";
  /** Pre-registered client ID; takes priority over stored clients, CIMD and dynamic registration. */
  clientId?: string;
  /** Client secret for confidential clients */
  clientSecret?: string;
  /** Private-key authentication instead of clientSecret; requires clientId or a custom clientMetadataUrl. */
  privateKeyJwt?: OAuthPrivateKeyJwtConfig;
  /** Noninteractive ID-token -> ID-JAG -> MCP access token flow; omit grantType. */
  crossAppAccess?: OAuthCrossAppAccessConfig;
  /** Requested OAuth scopes */
  scope?: string;
  /** Extra authorization URL parameters for provider-specific extensions. Flow-owned parameters cannot be overridden. */
  authorizationParams?: Record<string, string>;
  /** Exact authorization-code redirect URI for pre-registered clients */
  redirectUri?: string;
  /** Client display name for dynamic registration */
  clientName?: string;
  /** Client homepage URI for dynamic registration */
  clientUri?: string;
  /** Client metadata document URL. Eligible browser clients default to Pi MCP Adapter's shared identity; false opts out for new registrations. Stored clients keep priority. */
  clientMetadataUrl?: string | false;
}

// Server configuration
export interface ServerEntry {
  command?: string;
  args?: string[];
  /** Explicit rmcp-mux Unix-domain socket path. Mutually exclusive with command and url. */
  socket?: string;
  env?: Record<string, string>;
  cwd?: string;
  /** HTTP defaults to auto negotiation; stdio/socket default to legacy. */
  protocolVersion?: "auto" | "legacy";
  /** Trust explicit readOnlyHint/idempotentHint annotations for one modern transport retry. Defaults to false. */
  retryOnTransportFailure?: boolean;
  // HTTP fields
  url?: string;
  headers?: Record<string, string>;
  /**
   * Authentication type:
   * - 'oauth' - Use OAuth 2.1 (auto-discovers endpoints, supports dynamic client registration)
   * - 'bearer' - Use static Bearer token
   * - false - Disable authentication
   * If not specified and url is present, OAuth will be auto-detected unless custom headers are configured
   */
  auth?: "oauth" | "bearer" | false;
  bearerToken?: string;
  bearerTokenEnv?: string;
  /**
   * OAuth configuration (optional).
   * Eligible browser clients use the shared client metadata document when supported, otherwise dynamic registration.
   * Set to false to explicitly disable OAuth for this server.
   */
  oauth?: OAuthConfig | false;
  lifecycle?: "keep-alive" | "lazy" | "lazy-keep-alive" | "eager";
  idleTimeout?: number; // minutes, overrides global setting
  requestTimeoutMs?: number; // milliseconds, overrides global request timeout when > 0
  // Resource handling
  exposeResources?: boolean;
  // Direct tool registration
  directTools?: boolean | string[];
  // Override settings.toolPrefix for this server.
  toolPrefix?: ToolPrefix;
  // Include/exclude specific MCP tools/resources by original or prefixed name
  includeTools?: string[];
  excludeTools?: string[];
  // Require interactive approval before calling matching MCP tools/resources.
  approveTools?: boolean | string[];
  // Debug
  debug?: boolean; // Show server stderr (default: false)
  /** Enable metadata-only JSONL protocol tracing for this server. */
  trace?: boolean;
  // Keep configuration visible without allowing connections or execution.
  disabled?: boolean;
}

// Output guard tuning (settings.outputGuard object form)
export interface McpOutputGuardSettings {
  /** Maximum inline MCP text output bytes before truncation/spill-to-disk. Defaults to 51200 (50 KiB). */
  maxBytes?: number;
  /** Maximum inline MCP text output lines before truncation/spill-to-disk. Defaults to 2000. */
  maxLines?: number;
  /** Maximum details.mcpResult JSON bytes kept raw; larger results are summarized and spilled to disk. Defaults to 16384 (16 KiB). */
  detailsMaxBytes?: number;
}

// Settings
export type ToolPrefix = "server" | "none" | "short" | "mcp";
export type HostConfigDiscovery = "off" | "on";
export type McpFooterStatus = "full" | "compact" | "off";

export interface McpTraceSettings {
  /** Enable tracing for all servers unless a server sets trace to false. */
  enabled?: boolean;
  /** JSONL destination; relative paths are resolved from the session cwd. */
  file?: string;
  /** Maximum per-session trace file size in bytes. */
  maxBytes?: number;
  /** Maximum events retained in the per-session trace file. */
  maxEvents?: number;
}

export interface McpSettings {
  toolPrefix?: ToolPrefix;
  /** Show the plug prefix in MCP status and connection text (default: true). Set to false to disable it. */
  showStatusIcon?: boolean;
  /** Footer status verbosity: full details, compact connected/enabled count, or no footer status. Defaults to compact. */
  mcpFooterStatus?: McpFooterStatus;
  /** Discover detected host-specific MCP configs only when explicitly enabled. */
  hostConfigDiscovery?: HostConfigDiscovery;
  idleTimeout?: number; // minutes, default 10, 0 to disable
  requestTimeoutMs?: number; // milliseconds, overrides the SDK request timeout when > 0
  directTools?: boolean;
  /** Register the trusted MCP-only JavaScript scripting tool. Defaults to true; set false to hide it. */
  scriptMode?: boolean;
  /** Default approval gate for matching tools/resources; per-server settings override it. */
  approveTools?: boolean | string[];
  disableProxyTool?: boolean;
  /** Freeze direct-tool registration after the initial sync. Automatic metadata updates
   * (reconnects, lazy-connect, tool-list-changed) won't rebuild the system prompt,
   * preserving the prompt-cache prefix. The agent rediscovers explicitly via
   * mcp({ action: "connect", server: "server" }). Default: false. */
  freezeDirectTools?: boolean;
  autoAuth?: boolean;
  sampling?: boolean;
  samplingAutoApprove?: boolean;
  elicitation?: boolean;
  /**
   * Guard oversized MCP tool/resource output before it is returned to the model.
   * Defaults to true (50 KiB / 2,000 lines inline text, 16 KiB details.mcpResult).
   * Set to false to restore raw MCP output behavior, or pass an object to tune
   * the limits. Env kill switch: MCP_OUTPUT_GUARD=0.
   */
  outputGuard?: boolean | McpOutputGuardSettings;
  /**
   * Opt-in metadata-only MCP protocol tracing. Payloads, prompts, tool
   * arguments/results, authorization data, and URLs are never persisted.
   */
  trace?: McpTraceSettings;
  /**
   * Message returned in tool results when a server needs (re-)authentication.
   * "${server}" is substituted with the server name. Defaults to a TUI
   * instruction when unset.
   */
  authRequiredMessage?: string;
  /**
   * Parent of the fitch-mcp-adapter/ legacy OAuth import directory.
   * Relative paths resolve from the project root (cwd). Explicit v4 migration
   * reads the original directory; runtime never consumes those source files.
   * FITCH_MCP_OAUTH_DIR overrides the final runtime import path.
   * Persistent credentials live in the OS credential store. Plaintext files
   * in the runtime import directory are imported once and removed.
   */
  oauthDir?: string;
}

// Root config
export interface McpConfig {
  mcpServers: Record<string, ServerEntry>;
  imports?: ImportKind[];
  settings?: McpSettings;
}
