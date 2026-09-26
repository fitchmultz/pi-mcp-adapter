import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
  name?: string;
  bin?: Record<string, string>;
  repository?: { url?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  files?: string[];
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  exports?: Record<string, unknown>;
  types?: string;
  scripts?: Record<string, string>;
};

const hostPeerPackages = {
  "@earendil-works/pi-ai": packageJson.devDependencies?.["@earendil-works/pi-coding-agent"],
  "@earendil-works/pi-coding-agent": packageJson.devDependencies?.["@earendil-works/pi-coding-agent"],
  "@earendil-works/pi-tui": packageJson.devDependencies?.["@earendil-works/pi-coding-agent"],
  "typebox": "1.3.34",
};

describe("package.json files", () => {
  it("uses the owned package, helper executable and repository", () => {
    expect(packageJson.name).toBe("@fitchmultz/pi-mcp-adapter");
    expect(packageJson.bin).toEqual({ "fitch-mcp-adapter": "cli.js" });
    expect(packageJson.repository?.url).toBe("git+https://github.com/fitchmultz/pi-mcp-adapter.git");
    expect(packageJson.files).toContain("OAUTH.md");
  });

  it("exports only the compiled runtime and its declarations", () => {
    expect(packageJson.types).toBe("./dist/index.d.ts");
    expect(packageJson.exports).toEqual({
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      "./types": { types: "./dist/types.d.ts", default: "./dist/types.js" },
    });
    expect(packageJson.files).toContain("dist");
    expect((packageJson.files ?? []).filter((entry) => entry.endsWith(".ts"))).toEqual([]);
  });
});

describe("public OAuth client metadata", () => {
  it("defines and publishes the shared native public-client identity for source consumers", () => {
    expect(packageJson.files).toContain("docs/client-metadata.json");
    const metadata = JSON.parse(readFileSync(join(repoRoot, "docs/client-metadata.json"), "utf-8"));

    expect(metadata).toEqual({
      client_id: "https://fitchmultz.github.io/pi-mcp-adapter/client-metadata.json",
      client_name: "Fitch MCP Adapter",
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
      expect(exactVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(packageJson.devDependencies?.[name]).toBe(exactVersion);
    }
  });

  it("uses stable split SDK v2 and Apps v2 without SDK v1", () => {
    const deps = packageJson.dependencies ?? {};
    expect(deps["@modelcontextprotocol/sdk"]).toBeUndefined();
    expect(deps["@modelcontextprotocol/client"]).toBe(deps["@modelcontextprotocol/core"]);
    expect(packageJson.devDependencies?.["@modelcontextprotocol/server"]).toBe(deps["@modelcontextprotocol/core"]);
    expect(deps["@modelcontextprotocol/ext-apps"]).toMatch(/^2\./);
    expect(deps["@modelcontextprotocol/server"]).toBeUndefined();
    expect(packageJson.peerDependencies?.["@modelcontextprotocol/server"]).toBeUndefined();
    expect(packageJson.peerDependencies?.zod).toBeUndefined();
    expect(deps.ajv).toBeUndefined();
    expect(deps["ajv-formats"]).toBeUndefined();
  });

  it("builds the committed bridge with development-only esbuild", () => {
    expect(packageJson.scripts?.["build:bridge"]).toBe("node ./scripts/build-app-bridge.mjs");
    expect(packageJson.devDependencies?.esbuild).toBeDefined();
    expect(packageJson.dependencies?.esbuild).toBeUndefined();
  });

  it("uses the same Apps v2 graph in the interactive visualizer", () => {
    const example = JSON.parse(readFileSync(join(repoRoot, "examples/interactive-visualizer/package.json"), "utf-8"));
    for (const name of ["client", "core", "ext-apps"]) {
      expect(example.dependencies[`@modelcontextprotocol/${name}`]).toBe(packageJson.dependencies?.[`@modelcontextprotocol/${name}`]);
    }
    expect(example.dependencies["@modelcontextprotocol/server"]).toBe(packageJson.devDependencies?.["@modelcontextprotocol/server"]);
    expect(example.dependencies["@modelcontextprotocol/sdk"]).toBeUndefined();
    expect(example.dependencies.zod).toBe(packageJson.dependencies?.zod);
    expect(example.devDependencies.esbuild).toBe(packageJson.devDependencies?.esbuild);
  });
});
