import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
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
  "typebox": "1.3.7",
};

describe("package.json files", () => {
  it("uses the owned package, helper executable and repository", () => {
    expect(packageJson.name).toBe("@fitchmultz/pi-mcp-adapter");
    expect(packageJson.bin).toEqual({ "fitch-mcp-adapter": "cli.js" });
    expect(packageJson.repository?.url).toBe("git+https://github.com/fitchmultz/pi-mcp-adapter.git");
    expect(packageJson.files).toContain("OAUTH.md");
  });

  it("exports generated declarations while retaining source runtime entries", () => {
    expect(packageJson.types).toBe("./dist/index.d.ts");
    expect(packageJson.exports).toMatchObject({
      ".": {
        types: "./dist/index.d.ts",
        import: "./index.ts",
        default: "./index.ts",
      },
      "./types": {
        types: "./dist/types.d.ts",
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
    expect(packageJson.dependencies?.["@modelcontextprotocol/ext-apps"]).toBe("2.0.0");
    expect(packageJson.dependencies?.["@modelcontextprotocol/sdk"]).toBeUndefined();
    expect(packageJson.dependencies?.["@modelcontextprotocol/client"]).toBe("2.0.0");
    expect(packageJson.dependencies?.["@modelcontextprotocol/core"]).toBe("2.0.0");
    expect(packageJson.devDependencies?.["@modelcontextprotocol/server"]).toBe("2.0.0");
    expect(packageJson.dependencies?.["@modelcontextprotocol/server"]).toBeUndefined();
    expect(packageJson.peerDependencies?.["@modelcontextprotocol/server"]).toBeUndefined();
    expect(packageJson.dependencies?.zod).toBe("^4.6.5");
    expect(packageJson.peerDependencies?.zod).toBe("^4.6.5");
    expect(packageJson.dependencies?.minisearch).toBe("^7.2.0");
    expect(packageJson.dependencies?.ajv).toBeUndefined();
    expect(packageJson.dependencies?.["ajv-formats"]).toBeUndefined();
  });

  it("publishes a reproducible bridge builder with development-only esbuild", () => {
    expect(packageJson.files).toContain("scripts/build-app-bridge.mjs");
    expect(packageJson.files).toContain("app-bridge.bundle.js");
    expect(packageJson.scripts?.["build:bridge"]).toBe("node ./scripts/build-app-bridge.mjs");
    expect(packageJson.devDependencies?.esbuild).toBe("^0.28.2");
    expect(packageJson.dependencies?.esbuild).toBeUndefined();
  });

  it("uses the same Apps v2 graph in the interactive visualizer", () => {
    const example = JSON.parse(readFileSync(join(repoRoot, "examples/interactive-visualizer/package.json"), "utf-8"));
    for (const name of ["client", "core", "ext-apps", "server"]) {
      expect(example.dependencies[`@modelcontextprotocol/${name}`]).toBe("2.0.0");
    }
    expect(example.dependencies["@modelcontextprotocol/sdk"]).toBeUndefined();
    expect(example.dependencies.zod).toBe(packageJson.dependencies?.zod);
    expect(example.devDependencies.esbuild).toBe(packageJson.devDependencies?.esbuild);
  });
});
