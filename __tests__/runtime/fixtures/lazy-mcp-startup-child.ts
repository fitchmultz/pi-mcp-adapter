import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { join, resolve } from "node:path";
import type { ExtensionError } from "@earendil-works/pi-coding-agent";

// Synchronous hooks observe native ESM and CommonJS loads. Pi's source loader
// can also execute transformed modules through require.cache; include that graph
// rather than mistaking a clean ESM-only trace for a clean native startup.
const loaded = new Set<string>();
const hooks = registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    loaded.add(url);
    return result;
  },
});
const require = createRequire(import.meta.url);
function loadedModules(pattern: RegExp): string[] {
  return [...new Set([...loaded, ...Object.keys(require.cache)])]
    .filter((url) => pattern.test(url))
    .sort();
}
const sdkModules = () => loadedModules(/(?:\/|%2[fF])@modelcontextprotocol(?:\/|%2[fF])/);
const zodModules = () => loadedModules(/(?:\/|%2[fF])zod(?:\/|%2[fF])/);

const agentDir = process.env.PI_CODING_AGENT_DIR;
const configPath = process.env.MCP_CHILD_CONFIG;
const projectDir = process.env.MCP_CHILD_PROJECT_DIR;
const adapterPath = process.env.MCP_CHILD_ADAPTER_PATH;
const eventsPath = process.env.MCP_STARTUP_FIXTURE_EVENTS;
if (
  agentDir === undefined ||
  agentDir === "" ||
  configPath === undefined ||
  configPath === "" ||
  projectDir === undefined ||
  projectDir === "" ||
  adapterPath === undefined ||
  adapterPath === "" ||
  eventsPath === undefined ||
  eventsPath === ""
) {
  throw new Error("Missing lazy-startup child harness environment");
}
const sdk = await import("@earendil-works/pi-coding-agent");
const settingsManager = sdk.SettingsManager.inMemory();
const eventBus = sdk.createEventBus();
const statuses: unknown[] = [];
const unsubscribe = eventBus.on("fitch-mcp-adapter/status/v1", (snapshot: unknown) => {
  statuses.push(snapshot);
});
const loader = new sdk.DefaultResourceLoader({
  cwd: projectDir,
  agentDir,
  settingsManager,
  eventBus,
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noContextFiles: true,
  noThemes: true,
  additionalExtensionPaths: [adapterPath],
});
await loader.reload();
assert.deepEqual(
  loader.getExtensions().errors,
  [],
  "Source extension must load in the actual Pi loader",
);
const sourceLoaded = loader
  .getExtensions()
  .extensions.some((extension) => resolve(extension.path) === resolve(adapterPath));
assert(sourceLoaded, "Pi must load the source entrypoint, not an existing dist build");
const modelRuntime = await sdk.ModelRuntime.create({
  authPath: join(agentDir, "auth.json"),
  modelsPath: null,
  allowModelNetwork: false,
});
const { session } = await sdk.createAgentSession({
  cwd: projectDir,
  agentDir,
  resourceLoader: loader,
  sessionManager: sdk.SessionManager.inMemory(projectDir),
  settingsManager,
  modelRuntime,
  noTools: "builtin",
  tools: ["mcp", "lazy00_echo"],
});
const errors: ExtensionError[] = [];
try {
  session.extensionRunner.setFlagValue("mcp-config", configPath);
  await session.bindExtensions({
    mode: "print",
    onError: (error) => errors.push(error),
  });
  // Startup initialization is intentionally background work. Wait for its actual
  // status event, not a guessed delay or a mock initializeMcp completion.
  const deadline = Date.now() + 10_000;
  while (!statuses.some(hasAllServers)) {
    assert(
      Date.now() < deadline,
      `Timed out waiting for native MCP startup: ${JSON.stringify(errors)}`,
    );
    await new Promise<void>((complete) => {
      setTimeout(complete, 10);
    });
  }
  const tools = session.extensionRunner.getAllRegisteredTools().map(({ definition }) => ({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
  }));
  const commands = session.extensionRunner
    .getRegisteredCommands()
    .map((command) => ({
      name: command.name,
      description: command.description,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const startupStatus = statuses.at(-1);
  const activeTools = session.getActiveToolNames().sort();
  const startupSdkModules = sdkModules();
  const startupZodModules = zodModules();
  const eventsBeforeCall = await readEvents(eventsPath);
  // Use Pi's native registered-tool wrapper to supply its real runtime context.
  // No assistant/model is needed to exercise registration -> stdio -> result.
  const registered = session.extensionRunner
    .getAllRegisteredTools()
    .find((tool) => tool.definition.name === "lazy00_echo");
  assert(registered, "The cached direct tool must be registered before first use");
  const call = await sdk
    .wrapRegisteredTool(registered, session.extensionRunner)
    .execute("startup-regression", { text: "first use" });
  console.log(
    `LAZY_MCP_STARTUP=${JSON.stringify({
      sourceLoaded,
      activeTools,
      errors,
      tools,
      commands,
      startupStatus,
      startupSdkModules,
      afterCallSdkModules: sdkModules(),
      startupZodModules,
      afterCallZodModules: zodModules(),
      eventsBeforeCall,
      eventsAfterCall: await readEvents(eventsPath),
      call,
    })}`,
  );
} finally {
  try {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  } finally {
    session.dispose();
    unsubscribe();
    hooks.deregister();
  }
}

function hasAllServers(snapshot: unknown): boolean {
  return (
    typeof snapshot === "object" &&
    snapshot !== null &&
    "servers" in snapshot &&
    Array.isArray(snapshot.servers) &&
    snapshot.servers.length === 15
  );
}

async function readEvents(path: string): Promise<unknown[]> {
  try {
    return (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line): unknown => JSON.parse(line));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
