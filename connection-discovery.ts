import type { Client, RequestOptions } from "@modelcontextprotocol/client";
import type { ManagedClient } from "./connection-runtime.ts";
import type { ServerConnection } from "./server-connection.ts";
import type { McpPrompt, McpResource, McpResourceTemplate, McpTool } from "./types.ts";
import { throwIfAborted } from "./abort.ts";
import { logger } from "./logger.ts";
import { discoverServerSkills } from "./mcp-skills.ts";

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

export async function populateConnectionCatalogs(input: {
  readonly serverName: string;
  readonly client: ManagedClient;
  readonly connection: ServerConnection;
  readonly requestOptions: RequestOptions | undefined;
  readonly exposeSkills: boolean;
  readonly signal: AbortSignal | undefined;
  readonly isOAuthChallenge: (error: unknown) => boolean;
  readonly getAuthError: () => Error | undefined;
}): Promise<void> {
  const {
    serverName,
    client,
    connection,
    requestOptions,
    exposeSkills,
    signal,
    isOAuthChallenge,
    getAuthError,
  } = input;
  const catalogs = [
    fetchAllTools(client, requestOptions),
    fetchAllResources(client, requestOptions),
    fetchAllResourceTemplates(client, requestOptions),
    fetchAllPrompts(client, requestOptions),
    discoverServerSkills({ serverName, client, exposeSkills, signal }),
  ] as const;
  const [toolResult] = await Promise.allSettled(catalogs);
  throwIfAborted(signal);
  if (toolResult.status === "rejected" && !isOAuthChallenge(toolResult.reason)) {
    const reason: unknown = toolResult.reason;
    return Promise.reject(reason);
  }
  const authError = getAuthError();
  if (authError) {
    throw authError;
  }
  const [tools, resources, resourceTemplates, promptResult, skillResult] =
    await Promise.all(catalogs);
  connection.tools = tools;
  connection.resources = resources;
  connection.resourceTemplates = resourceTemplates;
  connection.prompts = promptResult.prompts;
  connection.promptDiscoveryFailed = promptResult.failed;
  connection.skillDiscoveryFailed = skillResult.failed === true;
  if (skillResult.skills.length > 0) {
    connection.skills = skillResult.skills.map((bundle) => bundle.metadata);
    connection.verifiedSkillBundles = skillResult.skills;
  }
}
