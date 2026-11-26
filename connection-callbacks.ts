import type { Client, UrlElicitationRequiredError } from "@modelcontextprotocol/client";
import type * as ConnectionRuntime from "./connection-runtime.ts";
import type { ManagedClient } from "./connection-runtime.ts";
import type { ServerSamplingConfig } from "./sampling-handler.ts";
import type { ServerElicitationConfig } from "./elicitation-handler.ts";
import type { ConnectionLifecycle } from "./connection-lifecycle.ts";
import type {
  MetadataListChangedListener,
  UiStreamListener,
  ServerConnection,
} from "./server-connection.ts";
import { type ServerDefinition, isNonInteractiveOAuth } from "./types.ts";
import { supportsOAuth } from "./mcp-oauth-runtime.ts";
import { ADAPTER_VERSION, hasServerUrl } from "./utils.ts";
import { logger } from "./logger.ts";
import type { ConnectionCatalogs } from "./connection-catalogs.ts";

export class ConnectionCallbacks {
  samplingConfig: ServerSamplingConfig | undefined;
  elicitationConfig: ServerElicitationConfig | undefined;
  metadataListChangedListener: MetadataListChangedListener | undefined;
  private readonly acceptedUrlElicitations = new Map<string, Set<string>>();
  private readonly uiStreamListeners = new Map<string, UiStreamListener>();
  private readonly catalogs = new WeakMap<Client, ConnectionCatalogs>();
  private readonly templateRefreshGenerations = new WeakMap<Client, number>();

  private readonly lifecycle: ConnectionLifecycle;

  constructor(lifecycle: ConnectionLifecycle) {
    this.lifecycle = lifecycle;
  }

  /** Adopt native accepted catalogs before the connection becomes visible. */
  publish(connection: ServerConnection): void {
    const catalogs = this.catalogs.get(connection.client);
    const tools = catalogs?.tools();
    const resources = catalogs?.resources();
    const resourceTemplates = catalogs?.resourceTemplates();
    const prompts = catalogs?.prompts();
    Object.assign(connection, {
      ...(tools === undefined ? {} : { tools }),
      ...(resources === undefined ? {} : { resources }),
      ...(resourceTemplates === undefined ? {} : { resourceTemplates }),
      ...(prompts === undefined ? {} : { prompts, promptDiscoveryFailed: false }),
    });
  }

  clearServer(name: string): void {
    // close(name) forgets the server's pending browser prompts: a completion notification
    // arriving after close must not claim a live connection.
    this.acceptedUrlElicitations.delete(name);
  }

  clear(): void {
    this.uiStreamListeners.clear();
    this.acceptedUrlElicitations.clear();
    this.samplingConfig = undefined;
    this.elicitationConfig = undefined;
  }

  private buildClientCapabilities(definition: ServerDefinition) {
    return {
      ...(supportsOAuth(definition) && isNonInteractiveOAuth(definition.oauth)
        ? {
            extensions: {
              [definition.oauth !== false && definition.oauth?.crossAppAccess
                ? "io.modelcontextprotocol/enterprise-managed-authorization"
                : "io.modelcontextprotocol/oauth-client-credentials"]: {},
            },
          }
        : {}),
      ...(this.samplingConfig ? { sampling: {} } : {}),
      ...(this.elicitationConfig
        ? {
            elicitation: {
              form: {},
              ...(this.elicitationConfig.allowUrl ? { url: {} } : {}),
            },
          }
        : {}),
    };
  }

  createClient(
    serverName: string,
    definition: ServerDefinition,
    runtime: typeof ConnectionRuntime,
  ): ManagedClient {
    const { ManagedClient, registerSamplingHandler, registerElicitationHandler } = runtime;
    const capabilities = this.buildClientCapabilities(definition);
    const catalogs = new runtime.ConnectionCatalogs();
    const client = new ManagedClient(
      { name: `pi-mcp-${serverName}`, version: ADAPTER_VERSION },
      {
        responseCacheStore: catalogs,
        versionNegotiation: {
          mode: definition.protocolVersion ?? (hasServerUrl(definition) ? "auto" : "legacy"),
        },
        // ponytail: reject catalogs over 1024 pages; raise this native cap if a real catalog needs more.
        listMaxPages: 1024,
        ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
        listChanged: {
          tools: {
            onChanged: (error: Error | null) => {
              this.handleToolsListChanged(serverName, client, error);
            },
          },
          resources: {
            onChanged: (error: Error | null) => {
              this.handleResourcesListChanged(
                serverName,
                client,
                error,
                runtime.isMethodNotFoundError,
              );
            },
          },
          prompts: {
            onChanged: (error: Error | null) => {
              this.handlePromptsListChanged(serverName, client, error);
            },
          },
        },
      },
    );
    client.serverName = serverName;
    this.catalogs.set(client, catalogs);
    // The client is claimed into disposal here. ConnectionFactory releases the claim if the
    // attempt fails before connect; after that, ConnectionDisposal owns the release.
    this.lifecycle.disposal.own(client);
    if (this.samplingConfig) {
      registerSamplingHandler(client, { ...this.samplingConfig, serverName }, (run) =>
        client.ownCallback("sampling callback", run),
      );
    }
    if (this.elicitationConfig) {
      registerElicitationHandler(
        client,
        {
          ...this.elicitationConfig,
          serverName,
          onUrlAccepted: (elicitationId) => this.rememberUrlElicitation(serverName, elicitationId),
        },
        (run) => client.ownCallback("elicitation callback", run),
      );
      if (this.elicitationConfig.allowUrl) {
        client.setNotificationHandler("notifications/elicitation/complete", (notification) => {
          if (this.lifecycle.runtimeSignal?.aborted === true) {
            return;
          }
          const accepted = this.acceptedUrlElicitations.get(serverName);
          if (accepted?.delete(notification.params.elicitationId) !== true) {
            return;
          }
          if (accepted.size === 0) {
            this.acceptedUrlElicitations.delete(serverName);
          }
          this.elicitationConfig?.ui.notify(
            `MCP browser interaction for ${serverName} completed. You can retry the tool now.`,
            "info",
          );
        });
      }
    }
    return client;
  }

  private handleToolsListChanged(serverName: string, client: Client, error: Error | null): void {
    if (error) {
      logger.debug(`MCP: tools/list_changed refresh failed for ${serverName}: ${error.message}`);
      return;
    }
    const tools = this.catalogs.get(client)?.tools();
    if (!tools) {
      return;
    }
    const connection = this.lifecycle.getConnection(serverName);
    // Re-check identity after the refresh await: a replaced connection's refresh is dropped.
    if (!connection || connection.client !== client || connection.status !== "connected") {
      return;
    }
    connection.tools = tools;
    this.metadataListChangedListener?.(serverName, "tools-list-changed");
  }

  private handlePromptsListChanged(serverName: string, client: Client, error: Error | null): void {
    if (error) {
      logger.debug(`MCP: prompts/list_changed refresh failed for ${serverName}: ${error.message}`);
      return;
    }
    const prompts = this.catalogs.get(client)?.prompts();
    if (!prompts) {
      return;
    }
    const connection = this.lifecycle.getConnection(serverName);
    if (!connection || connection.client !== client || connection.status !== "connected") {
      return;
    }
    connection.prompts = prompts;
    connection.promptDiscoveryFailed = false;
    this.metadataListChangedListener?.(serverName, "prompts-list-changed");
  }

  private handleResourcesListChanged(
    serverName: string,
    client: Client,
    error: Error | null,
    isMethodNotFound: (error: unknown) => boolean,
  ): void {
    if (error) {
      logger.debug(
        `MCP: resources/list_changed refresh failed for ${serverName}: ${error.message}`,
      );
      return;
    }
    const resources = this.catalogs.get(client)?.resources();
    if (!resources) {
      return;
    }
    const connection = this.lifecycle.getConnection(serverName);
    if (!connection || connection.client !== client || connection.status !== "connected") {
      return;
    }
    connection.resources = resources;
    connection.resourceTemplatesStale = true;
    const generation = (this.templateRefreshGenerations.get(client) ?? 0) + 1;
    this.templateRefreshGenerations.set(client, generation);
    this.refreshTemplatesOnResourcesChanged({
      serverName,
      client,
      connection,
      generation,
      isMethodNotFound,
    }).catch((refreshError: unknown) => {
      const message = refreshError instanceof Error ? refreshError.message : String(refreshError);
      logger.debug(`MCP: resources/templates/list refresh failed for ${serverName}: ${message}`);
    });
  }

  private async fetchTemplatesForListChanged(
    serverName: string,
    client: Client,
    signal: AbortSignal | undefined,
    isMethodNotFound: (error: unknown) => boolean,
  ): Promise<ServerConnection["resourceTemplates"] | undefined> {
    try {
      const result = await client.listResourceTemplates(undefined, {
        ...(signal ? { signal } : {}),
        cacheMode: "refresh",
      });
      return result.resourceTemplates;
    } catch (error) {
      if (signal?.aborted === true) {
        return undefined;
      }
      if (isMethodNotFound(error)) {
        return [];
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.debug(`MCP: resources/templates/list refresh failed for ${serverName}: ${message}`);
      return undefined;
    }
  }

  private isCurrentTemplateRefresh(
    serverName: string,
    client: Client,
    connection: ServerConnection,
    generation: number,
  ): boolean {
    return (
      this.lifecycle.runtimeSignal?.aborted !== true &&
      this.templateRefreshGenerations.get(client) === generation &&
      this.lifecycle.getConnection(serverName) === connection &&
      connection.client === client &&
      connection.status === "connected"
    );
  }

  private async refreshTemplatesOnResourcesChanged(input: {
    readonly serverName: string;
    readonly client: Client;
    readonly connection: ServerConnection;
    readonly generation: number;
    readonly isMethodNotFound: (error: unknown) => boolean;
  }): Promise<void> {
    const { serverName, client, connection, generation, isMethodNotFound } = input;
    const refreshed = await this.fetchTemplatesForListChanged(
      serverName,
      client,
      this.lifecycle.runtimeSignal,
      isMethodNotFound,
    );
    if (!this.isCurrentTemplateRefresh(serverName, client, connection, generation)) {
      return;
    }
    if (refreshed !== undefined) {
      connection.resourceTemplates = refreshed;
      connection.resourceTemplatesStale = false;
    }
    this.metadataListChangedListener?.(serverName, "resources-list-changed");
  }

  async handleUrlElicitationRequired(
    serverName: string,
    error: UrlElicitationRequiredError,
  ): Promise<"accept" | "decline" | "cancel"> {
    if (this.urlElicitationCancelled()) {
      return "cancel";
    }
    const { handleUrlElicitation } = await import("./elicitation-handler.ts");
    // The import yields; recheck cancellation and URL support before prompting.
    if (
      this.lifecycle.runtimeSignal?.aborted === true ||
      this.elicitationConfig?.allowUrl !== true
    ) {
      return "cancel";
    }
    for (const params of error.elicitations) {
      const result = await handleUrlElicitation(
        {
          ...this.elicitationConfig,
          serverName,
          onUrlAccepted: (elicitationId) => this.rememberUrlElicitation(serverName, elicitationId),
        },
        params,
      );
      if (result.action !== "accept") {
        return result.action;
      }
    }
    return "accept";
  }

  private urlElicitationCancelled(): boolean {
    return (
      this.lifecycle.runtimeSignal?.aborted === true || this.elicitationConfig?.allowUrl !== true
    );
  }

  private rememberUrlElicitation(serverName: string, elicitationId: string): void {
    if (this.lifecycle.runtimeSignal?.aborted === true) {
      return;
    }
    let accepted = this.acceptedUrlElicitations.get(serverName);
    if (!accepted) {
      accepted = new Set();
      this.acceptedUrlElicitations.set(serverName, accepted);
    }
    accepted.add(elicitationId);
  }

  attachAdapterNotificationHandlers(
    serverName: string,
    client: Client,
    schema: (typeof ConnectionRuntime)["serverStreamResultPatchNotificationSchema"],
  ): void {
    client.setNotificationHandler(
      schema.shape.method.value,
      { params: schema.shape.params },
      (params) => {
        this.uiStreamListeners.get(params.streamToken)?.(serverName, params);
      },
    );
  }

  registerUiStreamListener(streamToken: string, listener: UiStreamListener): void {
    this.uiStreamListeners.set(streamToken, listener);
  }

  removeUiStreamListener(streamToken: string): void {
    this.uiStreamListeners.delete(streamToken);
  }
}
