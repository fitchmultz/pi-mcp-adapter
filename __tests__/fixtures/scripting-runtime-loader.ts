import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { vi } from "vitest";
import { createTestExtensionContext } from "../test-extension-context.ts";

export function loaderFixtureTool(
  name: string,
  namespace?: { name: string },
): ToolDefinition<TSchema, Record<string, unknown>> {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    ...(namespace ? { namespace } : {}),
    async execute() {
      return { content: [], details: {} };
    },
  };
}

interface ScriptingLoaderHost {
  api: ExtensionAPI;
  dispose: () => Promise<void>;
  definitions: Map<string, ToolDefinition>;
  active: () => Array<{ name: string }>;
}
export async function createScriptingLoaderHost(
  allow: (ref: { name: string }) => boolean = () => true,
): Promise<ScriptingLoaderHost> {
  const native = await createTestExtensionContext("builtin", (api) => {
    api.registerTool(loaderFixtureTool("mcp"));
    api.registerTool(loaderFixtureTool("read"));
  });
  const { api } = native;
  const getAllTools = api.getAllTools.bind(api);
  const setActiveTools = api.setActiveTools.bind(api);
  vi.spyOn(api, "getAllTools").mockImplementation(() => getAllTools().filter(allow));
  vi.spyOn(api, "setActiveTools").mockImplementation((names) =>
    setActiveTools(names.filter((name) => allow({ name }))),
  );
  api.setActiveTools(["mcp", "read"]);
  return {
    api,
    dispose: native.dispose,
    get definitions(): Map<string, ToolDefinition> {
      return new Map(
        native.resourceLoader
          .getExtensions()
          .extensions.flatMap((extension) =>
            [...extension.tools]
              .filter(([name]) => name !== "mcp" && name !== "read")
              .map(([name, tool]) => [name, tool.definition]),
          ),
      );
    },
    active: (): Array<{ name: string }> => api.getActiveTools().map((name) => ({ name })),
  };
}
