import { readFileSync } from "node:fs";
import type { UiHostContext, UiResourceContent, UiResourceCsp } from "./types.ts";

// Use locally bundled AppBridge to avoid CDN Zod bundling issues
const DEFAULT_APP_BRIDGE_MODULE_URL = "/app-bridge.bundle.js";
const APP_SANDBOX = "allow-scripts allow-forms allow-modals allow-popups allow-downloads";

const HOST_STYLE = `
    :root {
      color-scheme: light dark;
      --bg: #0f1115;
      --surface: #181c22;
      --text: #ecf0f5;
      --muted: #a9b2bf;
      --accent: #43c0ff;
      --border: rgba(255, 255, 255, 0.12);
      --good: #34d399;
      --warn: #fbbf24;
      --bad: #f87171;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f6f7fb;
        --surface: #ffffff;
        --text: #1d2939;
        --muted: #667085;
        --accent: #0ea5e9;
        --border: rgba(15, 23, 42, 0.14);
        --good: #059669;
        --warn: #b45309;
        --bad: #b91c1c;
      }
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; height: 100%; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    body { display: flex; flex-direction: column; min-height: 100vh; min-height: 100dvh; }
    header { background: var(--surface); border-bottom: 1px solid var(--border); padding: calc(10px + env(safe-area-inset-top, 0px)) calc(14px + env(safe-area-inset-right, 0px)) 10px calc(14px + env(safe-area-inset-left, 0px)); display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .title { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
    .server { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; white-space: nowrap; }
    .tool { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge { border: 1px solid var(--border); border-radius: 999px; padding: 2px 8px; font-size: 11px; color: var(--muted); white-space: nowrap; }
    .controls { display: flex; gap: 8px; align-items: center; }
    .status { font-size: 12px; color: var(--muted); white-space: nowrap; }
    button { border: 1px solid var(--border); background: transparent; color: var(--text); border-radius: 8px; padding: 6px 10px; cursor: pointer; font-size: 12px; }
    button.primary { border-color: color-mix(in srgb, var(--good) 40%, var(--border) 60%); color: var(--good); }
    button.danger { border-color: color-mix(in srgb, var(--bad) 40%, var(--border) 60%); color: var(--bad); }
    button:hover { background: color-mix(in srgb, var(--surface) 75%, var(--accent) 25%); }
    main { flex: 1; min-height: 0; padding: 10px; padding-inline: calc(10px + env(safe-area-inset-left, 0px)) calc(10px + env(safe-area-inset-right, 0px)); padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px)); display: flex; }
    iframe { width: 100%; height: 100%; border: 1px solid var(--border); border-radius: 10px; background: white; }
    .overlay { position: fixed; inset: 0; background: color-mix(in srgb, var(--bg) 90%, black 10%); display: none; align-items: center; justify-content: center; z-index: 2; padding: 16px; }
    .overlay.visible { display: flex; }
    .panel { width: min(680px, calc(100vw - 40px)); background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 18px; }
    .panel h2 { margin: 0 0 8px; font-size: 16px; }
    .panel p { margin: 0; color: var(--muted); line-height: 1.4; font-size: 14px; white-space: pre-wrap; }
    @media (max-width: 640px) {
      header { align-items: stretch; flex-direction: column; gap: 8px; }
      .title { flex-wrap: wrap; row-gap: 4px; }
      .server { flex-basis: 100%; }
      .controls { width: 100%; }
      .status { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      button { min-height: 44px; padding: 10px 14px; }
      main { padding: 6px; padding-inline: calc(6px + env(safe-area-inset-left, 0px)) calc(6px + env(safe-area-inset-right, 0px)); padding-bottom: calc(6px + env(safe-area-inset-bottom, 0px)); }
      iframe { border-radius: 6px; }
      .panel { width: 100%; }
    }
  `;

export interface HostHtmlTemplateInput {
  sessionToken: string;
  uiResourceToken: string;
  serverName: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  resource: UiResourceContent;
  allowAttribute: string;
  requireToolConsent: boolean;
  hostContext?: UiHostContext;
  appBridgeModuleUrl?: string;
}

export function buildHostHtmlTemplate(input: HostHtmlTemplateInput): string {
  const config = safeInlineJSON({
    sessionToken: input.sessionToken,
    uiResourceToken: input.uiResourceToken,
    serverName: input.serverName,
    toolName: input.toolName,
    toolArgs: input.toolArgs,
    hostContext: input.hostContext ?? {},
    allowAttribute: input.allowAttribute,
    requireToolConsent: input.requireToolConsent,
  });
  const importMap = safeInlineJSON({
    imports: {
      "@modelcontextprotocol/ext-apps/app-bridge":
        input.appBridgeModuleUrl ?? DEFAULT_APP_BRIDGE_MODULE_URL,
    },
  });
  // Canonical browser source: host-browser-entry.ts. The build must generate and
  // freshness-check this asset, then copy it beside the emitted host template.
  const browserSource = readFileSync(new URL("./host-browser.bundle.js", import.meta.url), "utf8");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MCP UI - ${escapeHtml(input.serverName)} / ${escapeHtml(input.toolName)}</title>
  <style>${HOST_STYLE}</style>
</head>
<body>
  <header>
    <div class="title">
      <span class="server">MCP · <span id="server-name"></span></span>
      <span class="tool" id="tool-name"></span>
      <span class="badge">Sandboxed</span>
    </div>
    <div class="controls">
      <span class="status" id="status">Loading UI...</span>
      <button class="primary" id="done-btn" title="Cmd/Ctrl+Enter">Done</button>
      <button class="danger" id="cancel-btn" title="Escape">Cancel</button>
    </div>
  </header>
  <main>
    <iframe id="mcp-app" sandbox="${APP_SANDBOX}" referrerpolicy="no-referrer"></iframe>
  </main>
  <div class="overlay" id="error-overlay">
    <div class="panel">
      <h2>UI Error</h2>
      <p id="error-message"></p>
    </div>
  </div>
  <div class="overlay" id="completion-overlay">
    <div class="panel">
      <h2>Done</h2>
      <p>MCP UI session finished. You can close this page and return to Pi.</p>
    </div>
  </div>
  <script type="importmap">${importMap}</script>
  <script type="application/json" id="host-configuration">${config}</script>
  <script type="module">${browserSource}</script>
</body>
</html>`;
}

export function buildCspMetaContent(csp?: { [K in keyof UiResourceCsp]?: unknown }): string {
  const resourceDomains = sanitizeCspDomains(csp?.resourceDomains);
  const connectDomains = sanitizeCspDomains(csp?.connectDomains);
  const frameDomains = sanitizeCspDomains(csp?.frameDomains);
  const baseUriDomains = sanitizeCspDomains(csp?.baseUriDomains);

  return [
    "default-src 'none'",
    `sandbox ${APP_SANDBOX}`,
    toDirective("script-src", ["'self'", "'unsafe-inline'"], resourceDomains),
    toDirective("style-src", ["'self'", "'unsafe-inline'"], resourceDomains),
    toDirective("font-src", ["'self'"], resourceDomains),
    toDirective("img-src", ["'self'", "data:"], resourceDomains),
    toDirective("media-src", ["'self'", "data:"], resourceDomains),
    connectDomains.length > 0 ? `connect-src ${connectDomains.join(" ")}` : "connect-src 'none'",
    frameDomains.length > 0 ? `frame-src ${frameDomains.join(" ")}` : "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    baseUriDomains.length > 0 ? `base-uri ${baseUriDomains.join(" ")}` : "base-uri 'self'",
  ].join("; ");
}

function toDirective(name: string, trustedSources: string[], domains: string[]): string {
  return `${name} ${[...new Set([...trustedSources, ...domains])].join(" ")}`;
}

function sanitizeCspDomains(domains: unknown): string[] {
  if (!Array.isArray(domains)) {
    return [];
  }

  return [
    ...new Set(
      domains.filter(
        (domain): domain is string =>
          typeof domain === "string" &&
          domain.length > 0 &&
          // HTTP headers must be printable ASCII; rejecting all other code points also
          // excludes every C0/C1 control character before Node serializes the policy.
          /^[\x21-\x7E]+$/.test(domain) &&
          !/[;'"]/.test(domain),
      ),
    ),
  ];
}

function safeInlineJSON(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
