import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openMcpAuthPanel, openMcpPanel } from "../../commands.ts";
import { getAuthEntryFilePath } from "../../mcp-auth.ts";
import { createPanelHost } from "../fixtures/panel-host.ts";
import { requireValue } from "../fixtures/extension-lifecycle.ts";
import { createTestState } from "../test-state.ts";

const hosts: Awaited<ReturnType<typeof createPanelHost>>[] = [];
const directories: string[] = [];
beforeAll(() => initTheme());
afterEach(async () => {
  for (const host of hosts.splice(0)) {
    await host.dispose();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/gu, "");
}

function createState() {
  return createTestState({
    programmaticConfig: false,
    config: { mcpServers: { oauth: { url: "https://example.test/mcp", auth: "oauth" } } },
  });
}

const panels = [
  ["/mcp", openMcpPanel],
  ["/mcp-auth", (state, _pi, context) => openMcpAuthPanel(state, context)],
] satisfies [string, typeof openMcpPanel][];

describe("MCP panels with unreadable OAuth credentials", () => {
  it.each(panels)(
    "does not inspect browser credentials for CAA status in %s",
    async (_command, openPanel) => {
      vi.stubEnv("PI_MCP_ADAPTER_TEST_AUTH_STORE", "unavailable");
      const state = createState();
      const oauth = requireValue(state.config.mcpServers.oauth);
      oauth.oauth = {
        crossAppAccess: { idpUrl: "https://idp.example", clientId: "idp", idToken: "!exit 99" },
      };
      const host = await createPanelHost();
      hosts.push(host);
      const opening = openPanel(state, host.api, { ...host.context, cwd: "/tmp" });
      await expect.poll(host.component).toBeDefined();
      const rendered = stripAnsi(requireValue(host.component()).render(100).join("\n"));
      host.input("\x03");
      await expect(opening).resolves.toEqual({ configChanged: false });
      expect(rendered).not.toContain("needs auth");
      expect(rendered).not.toContain("OAuth credential store unavailable");
      expect(rendered).not.toContain("failed");
    },
  );

  it.each(
    [
      { store: "unavailable", message: "OAuth credential store unavailable" },
      { store: "memory", message: "Invalid OAuth credential record" },
    ].flatMap(({ store, message }) =>
      panels.map(([command, openPanel]) => ({ store, message, command, openPanel })),
    ),
  )(
    "opens $command without throwing and presents $message",
    async ({ store, message, openPanel }) => {
      const directory = mkdtempSync(join(tmpdir(), "pi-mcp-panel-invalid-credentials-"));
      directories.push(directory);
      vi.stubEnv("FITCH_MCP_OAUTH_DIR", directory);
      vi.stubEnv("PI_MCP_ADAPTER_TEST_AUTH_STORE", store);
      const filePath = getAuthEntryFilePath("oauth");
      const bytes = JSON.stringify({
        serverUrl: "https://example.test/mcp",
        tokens: { accessToken: 17 },
      });
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, bytes);
      const host = await createPanelHost();
      hosts.push(host);
      const opening = openPanel(createState(), host.api, { ...host.context, cwd: "/tmp" });
      await expect.poll(host.component).toBeDefined();
      const rendered = stripAnsi(requireValue(host.component()).render(100).join("\n"));
      host.input("\x03");
      await expect(opening).resolves.toEqual({ configChanged: false });
      expect(rendered).toContain("failed");
      expect(rendered).not.toContain("needs auth");
      expect(rendered).toContain(message);
      expect(readFileSync(filePath, "utf8")).toBe(bytes);
    },
  );
});
