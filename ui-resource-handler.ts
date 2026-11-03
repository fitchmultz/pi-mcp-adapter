import type { ReadResourceResult } from "@modelcontextprotocol/client";
import { logger } from "./logger.ts";
import type { SessionRecoveryDeps } from "./session-recovery.ts";
import type { McpServerManager } from "./server-manager.ts";
import {
  isServerDisabled,
  type McpConfig,
  type UiResourceContent,
  type UiResourceMeta,
} from "./types.ts";
import { extractUiMeta } from "./ui-resource-meta.ts";

// MCP Apps resource media type; metadata reads must not import the app bridge.
export const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
type ResourceContent = ReadResourceResult["contents"][number];

interface ReadUiResourceOptions {
  config?: McpConfig;
  signal?: AbortSignal;
  onNeedsAuth?: SessionRecoveryDeps["onNeedsAuth"];
}

export class UiResourceHandler {
  private readonly log = logger.child({ component: "UiResourceHandler" });
  private readonly manager: McpServerManager;
  private readonly config: McpConfig | undefined;

  constructor(manager: McpServerManager, config?: McpConfig) {
    this.manager = manager;
    this.config = config;
  }

  async readUiResource(
    serverName: string,
    uri: string,
    options: ReadUiResourceOptions = {},
  ): Promise<UiResourceContent> {
    // Preserve lazy SDK loading on extension startup.
    const [{ UrlElicitationRequiredError }, { SessionRecoveryAuthRequiredError }] =
      await Promise.all([import("@modelcontextprotocol/client"), import("./session-recovery.ts")]);
    const log = this.log.child({ server: serverName, uri });
    if (!uri.startsWith("ui://")) {
      throw new Error(`Invalid UI resource "${uri}": URI must start with ui://`);
    }
    log.debug("Fetching UI resource");
    let result: ReadResourceResult;
    try {
      result = await this.fetchResource(serverName, uri, options);
    } catch (error) {
      if (
        error instanceof UrlElicitationRequiredError ||
        error instanceof SessionRecoveryAuthRequiredError
      ) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      log.error("Failed to read resource", error instanceof Error ? error : undefined);
      throw new Error(`Failed to fetch UI resource "${uri}": ${message}`, { cause: error });
    }
    const resource = this.toUiResource(result, serverName, uri, log);
    log.debug("Resource loaded successfully", {
      contentLength: resource.html.length,
      hasCsp: Boolean(resource.meta.csp),
    });
    return resource;
  }

  private async fetchResource(
    serverName: string,
    uri: string,
    options: ReadUiResourceOptions,
  ): Promise<ReadResourceResult> {
    const config = options.config ?? this.config;
    if (!config) {
      return this.manager.readResource(serverName, uri, options.signal);
    }
    if (isServerDisabled(config.mcpServers[serverName])) {
      throw new Error(`MCP server "${serverName}" is disabled`);
    }
    const { withSessionRecovery } = await import("./session-recovery.ts");
    this.manager.touch(serverName);
    this.manager.incrementInFlight(serverName);
    try {
      return await withSessionRecovery(
        {
          manager: this.manager,
          config,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.onNeedsAuth ? { onNeedsAuth: options.onNeedsAuth } : {}),
        },
        serverName,
        (connection) =>
          connection.client.readResource(
            { uri },
            this.manager.getRequestOptions(serverName, options.signal),
          ),
      );
    } finally {
      this.manager.decrementInFlight(serverName);
      this.manager.touch(serverName);
    }
  }

  private getListResourceMeta(
    serverName: string,
    uri: string,
  ): Record<string, unknown> | undefined {
    const connection = this.manager.getConnection(serverName);
    return connection?.resources.find((entry) => entry.uri === uri)?._meta;
  }

  private toUiResource(
    result: ReadResourceResult,
    serverName: string,
    uri: string,
    log: ReturnType<typeof logger.child>,
  ): UiResourceContent {
    const content = selectContent(result, uri);
    const mimeType = content.mimeType;
    if (mimeType !== undefined && mimeType !== "" && !isHtmlMimeType(mimeType)) {
      log.warn("Unsupported MIME type", { mimeType });
      throw new Error(
        `Invalid UI resource "${uri}": unsupported MIME type "${mimeType}" (expected text/html or ${RESOURCE_MIME_TYPE})`,
      );
    }
    const html = toHtml(content);
    if (html.trim() === "") {
      log.warn("Resource content is empty");
      throw new Error(`Invalid UI resource "${uri}": content is empty`);
    }
    return {
      uri: content.uri,
      html,
      mimeType: mimeType ?? RESOURCE_MIME_TYPE,
      meta: mergeResourceMeta(
        extractUiMeta(content._meta),
        extractUiMeta(this.getListResourceMeta(serverName, uri)),
      ),
    };
  }
}

function mergeResourceMeta(content: UiResourceMeta, listed: UiResourceMeta): UiResourceMeta {
  const csp = content.csp ?? listed.csp;
  const permissions = content.permissions ?? listed.permissions;
  const domain = content.domain ?? listed.domain;
  const prefersBorder = content.prefersBorder ?? listed.prefersBorder;
  return {
    ...(csp !== undefined ? { csp } : {}),
    ...(permissions !== undefined ? { permissions } : {}),
    ...(domain !== undefined ? { domain } : {}),
    ...(prefersBorder !== undefined ? { prefersBorder } : {}),
  };
}

function selectContent(result: ReadResourceResult, preferredUri: string): ResourceContent {
  const contents = result.contents;
  const byUri = contents.find((content) => content.uri === preferredUri);
  if (byUri) {
    return byUri;
  }
  const byHtmlMime = contents.find(
    (content) =>
      content.mimeType !== undefined && content.mimeType !== "" && isHtmlMimeType(content.mimeType),
  );
  const selected = byHtmlMime ?? contents[0];
  if (!selected) {
    throw new Error(`No contents returned for UI resource: ${preferredUri}`);
  }
  return selected;
}

function isHtmlMimeType(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase();
  return normalized.startsWith("text/html") || normalized === RESOURCE_MIME_TYPE.toLowerCase();
}

function toHtml(content: ResourceContent): string {
  if ("text" in content) {
    return content.text;
  }
  return Buffer.from(content.blob, "base64").toString("utf-8");
}
