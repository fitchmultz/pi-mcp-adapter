import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  files?: string[];
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  exports?: Record<string, unknown>;
  types?: string;
};

const hostPeerPackages = {
  "@earendil-works/pi-ai": "0.84.0",
  "@earendil-works/pi-coding-agent": "0.84.0",
  "@earendil-works/pi-tui": "0.84.0",
  "typebox": "1.3.7",
};

describe("package.json files", () => {
  it("exports the TypeScript source entry for SDK consumers", () => {
    expect(packageJson.types).toBe("./index.ts");
    expect(packageJson.exports).toMatchObject({
      ".": {
        types: "./index.ts",
        import: "./index.ts",
        default: "./index.ts",
      },
      "./types": {
        types: "./types.ts",
        import: "./types.ts",
        default: "./types.ts",
      },
    });
  });

  it("publishes every root runtime TypeScript module", () => {
    const publishedFiles = new Set(packageJson.files ?? []);
    const runtimeModules = readdirSync(repoRoot)
      .filter((entry) => entry.endsWith(".ts"))
      .filter((entry) => !entry.endsWith(".test.ts"))
      .filter((entry) => entry !== "vitest.config.ts");

    expect(runtimeModules.length).toBeGreaterThan(0);
    expect(runtimeModules.filter((entry) => !publishedFiles.has(entry))).toEqual([]);
  });
});

describe("public OAuth client metadata", () => {
  it("defines the shared native public-client identity", () => {
    const metadata = JSON.parse(readFileSync(join(repoRoot, "docs/client-metadata.json"), "utf-8"));

    expect(metadata).toEqual({
      client_id: "https://fitchmultz.github.io/pi-mcp-adapter/client-metadata.json",
      client_name: "Pi MCP Adapter",
      client_uri: "https://github.com/fitchmultz/pi-mcp-adapter",
      redirect_uris: [
        "http://localhost:19876/callback",
        "http://127.0.0.1:19876/callback",
        "http://[::1]:19876/callback",
      ],
      application_type: "native",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });
});

describe("compiled extension peer resolution", () => {
  it("loads TUI panels statically so Pi resolves their host peers", () => {
    const commandsSource = readFileSync(join(repoRoot, "commands.ts"), "utf-8");

    expect(commandsSource).toContain('import { createMcpPanel } from "./mcp-panel.ts";');
    expect(commandsSource).toContain('import { createMcpSetupPanel } from "./mcp-setup-panel.ts";');
    expect(commandsSource).not.toMatch(/await import\(["']\.\/mcp-(?:setup-)?panel\.ts["']\)/);
  });
});

describe("package.json dependency policy", () => {
  it("treats Pi host packages as optional wildcard peers with exact dev pins", () => {
    const entries = Object.entries(hostPeerPackages);

    for (const [name, exactVersion] of entries) {
      expect(packageJson.peerDependencies?.[name]).toBe("*");
      expect(packageJson.peerDependenciesMeta?.[name]?.optional).toBe(true);
      expect(packageJson.dependencies?.[name]).toBeUndefined();
      expect(packageJson.devDependencies?.[name]).toBe(exactVersion);
    }
  });

  it("pins stable split SDK v2 and retains SDK v1 only for Apps", () => {
    expect(packageJson.dependencies?.["@modelcontextprotocol/ext-apps"]).toBeDefined();
    expect(packageJson.dependencies?.["@modelcontextprotocol/sdk"]).toBe("^1.30.0");
    expect(packageJson.dependencies?.["@modelcontextprotocol/client"]).toBe("2.0.0");
    expect(packageJson.dependencies?.["@modelcontextprotocol/core"]).toBe("2.0.0");
    expect(packageJson.devDependencies?.["@modelcontextprotocol/server"]).toBe("2.0.0");
    expect(packageJson.dependencies?.zod).toBeDefined();
    expect(packageJson.dependencies?.ajv).toBeUndefined();
    expect(packageJson.dependencies?.["ajv-formats"]).toBeUndefined();
  });
});
