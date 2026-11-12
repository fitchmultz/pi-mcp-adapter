import { InMemoryResponseCacheStore, type CacheKey } from "@modelcontextprotocol/client";
import {
  ListToolsResultSchema,
  ListResourcesResultSchema,
  ListPromptsResultSchema,
} from "@modelcontextprotocol/core";

/** Read only catalogs the native SDK accepted into its generation-guarded cache. */
export class ConnectionCatalogs extends InMemoryResponseCacheStore {
  private readonly keys = new Map<string, CacheKey>();

  override set(...args: Parameters<InMemoryResponseCacheStore["set"]>): number {
    const stamp = super.set(...args);
    if (["tools/list", "resources/list", "prompts/list"].includes(args[0].method)) {
      this.keys.set(args[0].method, args[0]);
    }
    return stamp;
  }

  private read(method: string): unknown {
    const key = this.keys.get(method);
    const entry = key === undefined ? undefined : this.get(key);
    return entry === undefined ? undefined : JSON.parse(entry.value);
  }

  tools(): ReturnType<typeof ListToolsResultSchema.parse>["tools"] | undefined {
    const value = this.read("tools/list");
    return value === undefined ? undefined : ListToolsResultSchema.parse(value).tools;
  }

  resources(): ReturnType<typeof ListResourcesResultSchema.parse>["resources"] | undefined {
    const value = this.read("resources/list");
    return value === undefined ? undefined : ListResourcesResultSchema.parse(value).resources;
  }

  prompts(): ReturnType<typeof ListPromptsResultSchema.parse>["prompts"] | undefined {
    const value = this.read("prompts/list");
    return value === undefined ? undefined : ListPromptsResultSchema.parse(value).prompts;
  }
}
