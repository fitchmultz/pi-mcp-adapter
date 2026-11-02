import { createToolLoader } from "../../tool-loader.ts";
import type { DirectToolSpec, McpConfig, MetadataCache, ToolPrefix } from "../../types.ts";
import { createTestExtensionContext } from "../test-extension-context.ts";

/** Exercise pin projection through the registered tool surface. */
export async function resolvePinnedTools(
  config: McpConfig,
  cache: MetadataCache | null,
  prefix: ToolPrefix,
  env?: string[],
): Promise<DirectToolSpec[]> {
  const host = await createTestExtensionContext("builtin");
  try {
    return createToolLoader(
      host.api,
      () => null,
      () => null,
    ).sync({ ...config, settings: { ...config.settings, toolPrefix: prefix } }, cache, env);
  } finally {
    await host.dispose();
  }
}
