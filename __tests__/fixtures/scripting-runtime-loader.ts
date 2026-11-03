import {
  type ExtensionAPI,
  type ExtensionContext,
  SessionManager,
  type SessionEntry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { vi } from "vitest";
import { asObjectRecord } from "../../mcp-output-values.ts";
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

type HistoryInput = { type: "message" } | { type: "custom"; customType: string; data: unknown };
interface ScriptingLoaderHost {
  api: ExtensionAPI;
  ctx: ExtensionContext;
  manager: SessionManager;
  dispose: () => Promise<void>;
  entries: SessionEntry[];
  definitions: Map<string, ToolDefinition>;
  active: () => Array<{ name: string }>;
  append: (...entries: HistoryInput[]) => void;
  copyHistory: (entries: SessionEntry[]) => void;
  lastSelection: () => Record<string, unknown>;
}
export async function createScriptingLoaderHost(
  allow: (ref: { name: string }) => boolean = () => true,
): Promise<ScriptingLoaderHost> {
  const native = await createTestExtensionContext("builtin", (api) => {
    api.registerTool(loaderFixtureTool("mcp"));
    api.registerTool(loaderFixtureTool("read"));
  });
  const { api, context: ctx } = native;
  const manager = ctx.sessionManager;
  if (!(manager instanceof SessionManager)) {
    await native.dispose();
    throw new Error("Expected the native SessionManager backing the extension context");
  }
  const getAllTools = api.getAllTools.bind(api);
  const setActiveTools = api.setActiveTools.bind(api);
  vi.spyOn(api, "getAllTools").mockImplementation(() => getAllTools().filter(allow));
  vi.spyOn(api, "setActiveTools").mockImplementation((names) =>
    setActiveTools(names.filter((name) => allow({ name }))),
  );
  api.setActiveTools(["mcp", "read"]);
  vi.spyOn(manager, "getEntry");
  return {
    api,
    ctx,
    manager,
    dispose: native.dispose,
    get entries(): SessionEntry[] {
      return manager.getEntries();
    },
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
    append: (...entries: HistoryInput[]): void => {
      for (const entry of entries) {
        if (entry.type === "custom") {
          manager.appendCustomEntry(entry.customType, entry.data);
        } else {
          manager.appendMessage({ role: "user", content: "unrelated", timestamp: Date.now() });
        }
      }
    },
    copyHistory: (entries: SessionEntry[]): void => {
      for (const entry of entries) {
        if (entry.type === "custom") {
          manager.appendCustomEntry(entry.customType, entry.data);
        }
      }
    },
    lastSelection: (): Record<string, unknown> => {
      const leaf = manager.getLeafEntry();
      const data: unknown = leaf?.type === "custom" ? leaf.data : undefined;
      const record = asObjectRecord(data);
      if (!record) {
        throw new Error("Expected a persisted selection snapshot");
      }
      return record;
    },
  };
}
