import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionFactory,
  type ExtensionRunner,
} from "@earendil-works/pi-coding-agent";

/** Create a real, isolated Pi extension context without loading user resources. */
export async function createTestExtensionContext(
  noTools: "all" | "builtin" = "all",
  factory?: ExtensionFactory,
): Promise<{
  api: ExtensionAPI;
  commandContext: ExtensionCommandContext;
  context: ExtensionContext;
  runner: ExtensionRunner;
  resourceLoader: DefaultResourceLoader;
  dispose: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "pi-mcp-test-context-"));
  try {
    const settingsManager = SettingsManager.inMemory();
    let api: ExtensionAPI | undefined;
    const resourceLoader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        async (extension) => {
          api = extension;
          await factory?.(extension);
        },
      ],
    });
    await resourceLoader.reload();
    if (api === undefined) {
      throw new Error("test extension did not load");
    }
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.inMemory(directory),
      noTools,
    });
    try {
      await session.bindExtensions({});
      return {
        api,
        commandContext: session.extensionRunner.createCommandContext(),
        context: session.extensionRunner.createContext(),
        runner: session.extensionRunner,
        resourceLoader,
        dispose: async () => {
          session.dispose();
          await rm(directory, { recursive: true, force: true });
        },
      };
    } catch (error) {
      session.dispose();
      throw error;
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
