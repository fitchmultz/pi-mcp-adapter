import type { Client, RequestOptions } from "@modelcontextprotocol/client";
import type { McpPrompt, McpResource, McpResourceTemplate, McpTool } from "./types.ts";
import { throwIfAborted } from "./abort.ts";
import { logger } from "./logger.ts";

export async function fetchAllTools(
  client: Client,
  requestOptions?: RequestOptions,
): Promise<McpTool[]> {
  return (await client.listTools(undefined, { ...requestOptions, cacheMode: "refresh" })).tools;
}

export async function fetchAllPrompts(
  client: Client,
  requestOptions?: RequestOptions,
): Promise<{ prompts: McpPrompt[]; failed: boolean }> {
  if (!client.getServerCapabilities()?.prompts) {
    return { prompts: [], failed: false };
  }
  try {
    return {
      prompts: (await client.listPrompts(undefined, { ...requestOptions, cacheMode: "refresh" }))
        .prompts,
      failed: false,
    };
  } catch (error) {
    if (requestOptions?.signal?.aborted === true) {
      throwIfAborted(requestOptions.signal);
    }
    logger.debug(
      `MCP: prompts/list failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { prompts: [], failed: true };
  }
}

export async function fetchAllResources(
  client: Client,
  requestOptions?: RequestOptions,
): Promise<McpResource[]> {
  if (!client.getServerCapabilities()?.resources) {
    return [];
  }
  try {
    return (await client.listResources(undefined, { ...requestOptions, cacheMode: "refresh" }))
      .resources;
  } catch (error) {
    if (requestOptions?.signal?.aborted === true) {
      throwIfAborted(requestOptions.signal);
    }
    logger.debug(
      `MCP: resources/list failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

export async function fetchAllResourceTemplates(
  client: Client,
  requestOptions?: RequestOptions,
): Promise<McpResourceTemplate[]> {
  if (!client.getServerCapabilities()?.resources) {
    return [];
  }
  try {
    return (
      await client.listResourceTemplates(undefined, { ...requestOptions, cacheMode: "refresh" })
    ).resourceTemplates;
  } catch (error) {
    if (requestOptions?.signal?.aborted === true) {
      throwIfAborted(requestOptions.signal);
    }
    logger.debug(
      `MCP: resources/templates/list failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}
