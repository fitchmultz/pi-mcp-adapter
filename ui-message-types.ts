import type { McpUiResourcePermissions } from "@modelcontextprotocol/ext-apps";
import { isConfigObject } from "./config-validation.ts";
import type { ContentBlock as McpContentBlock } from "@modelcontextprotocol/client";
import type { UiMessageParams } from "./ui-message-schema.ts";

// The schema owner loads Zod; this type-only re-export keeps extension startup free of it.
export type { UiMessageParams } from "./ui-message-schema.ts";

export interface UiResourceMeta {
  csp?: UiResourceCsp;
  permissions?: UiResourcePermissions;
  domain?: string;
  prefersBorder?: boolean;
}

export interface UiResourceContent {
  uri: string;
  html: string;
  mimeType?: string;
  meta: UiResourceMeta;
}

export interface UiProxyRequestBody<TParams> {
  token: string;
  params: TParams;
}

export interface UiProxyResult<T = Record<string, unknown>> {
  ok: boolean;
  result?: T;
  error?: string;
}

export interface UiResourceCsp {
  resourceDomains?: string[];
  connectDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

export type UiResourcePermissions = McpUiResourcePermissions;

export interface UiToolInfo {
  id?: string | number;
  tool: {
    name: string;
    description?: string;
    inputSchema?: unknown;
  };
}

export interface UiHostContext {
  toolInfo?: UiToolInfo;
  theme?: "light" | "dark";
  styles?: Record<string, unknown>;
  displayMode?: UiDisplayMode;
  availableDisplayModes?: UiDisplayMode[];
  containerDimensions?: {
    width?: number;
    maxWidth?: number;
    height?: number;
    maxHeight?: number;
  };
  [key: string]: unknown;
}

export type UiDisplayMode = "inline" | "fullscreen" | "pip";

// Stream schema values load Zod; runtime modules import them from ui-stream-types.ts
// so extension startup does not. public-types.ts keeps them on the published /types entry.
export type {
  UiStreamMode,
  VisualizationStreamPhase,
  VisualizationStreamFrameType,
  VisualizationStreamStatus,
  UiStreamHostContext,
  VisualizationStreamEnvelope,
  UiStreamCallToolResult,
  UiStreamResultPatchNotification,
  ServerStreamResultPatchNotification,
  UiStreamSummary,
} from "./ui-stream-types.ts";

/**
 * Extract prompt text from either legacy MCP UI message shapes or native AppBridge user messages.
 */
export function extractUiPromptText(params: UiMessageParams): string | undefined {
  if (params.type === "prompt" || (params.prompt !== undefined && params.prompt !== "")) {
    const prompt = params.prompt ?? textFromUiValue(params.message);
    return prompt === "" ? undefined : prompt;
  }

  if (params.role === "user" && Array.isArray(params.content)) {
    const text = params.content.map(textFromUiBlock).filter(Boolean).join("\n\n");
    return text === "" ? undefined : text;
  }

  return undefined;
}

/**
 * Structured UI handoff recovered from a canonical prompt envelope.
 */
export interface UiPromptHandoff {
  intent: string;
  params: Record<string, unknown>;
  raw: string;
}

/**
 * Parse a canonical named UI handoff encoded as `intent\n{json}`.
 */
export function parseUiPromptHandoff(prompt: string): UiPromptHandoff | undefined {
  const newlineIndex = prompt.indexOf("\n");
  if (newlineIndex <= 0) {
    return undefined;
  }

  const intent = prompt.slice(0, newlineIndex).trim();
  const payloadText = prompt.slice(newlineIndex + 1).trim();
  if (intent === "" || payloadText === "") {
    return undefined;
  }

  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(intent)) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(payloadText);
    if (!isConfigObject(parsed)) {
      return undefined;
    }
    return {
      intent,
      params: parsed,
      raw: prompt,
    };
  } catch {
    return undefined;
  }
}

/**
 * Accumulated messages from a UI session.
 * Collected during the session and available when it ends.
 */
export interface UiSessionMessages {
  /** Private JSONL history, readable with the normal paged result reader. */
  historyRef?: string;
  historyBytes?: number;
  historyCount?: number;
  historyError?: string;
  prompts: string[];
  notifications: string[];
  intents: Array<{ intent: string; params?: Record<string, unknown> }>;
  contexts: UiModelContextUpdate[];
}

export interface UiModelContextUpdate {
  summary: string;
  truncated: boolean;
  payload?: Record<string, unknown>;
}

export interface UiModelContextParams {
  content?: McpContentBlock[];
  structuredContent?: Record<string, unknown>;
}

export function createUiModelContextUpdate(
  params: UiModelContextParams,
  maxChars = 12_000,
): UiModelContextUpdate | undefined {
  const payload = Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined),
  );
  if (Object.keys(payload).length === 0) {
    return undefined;
  }

  const serialized = JSON.stringify(payload);
  if (serialized.length <= maxChars) {
    return { payload, summary: serialized, truncated: false };
  }

  return {
    summary: `${serialized.slice(0, Math.max(0, maxChars - 1))}…`,
    truncated: true,
  };
}

export interface UiOpenLinkResult {
  isError?: boolean;
  [key: string]: unknown;
}

export interface UiDisplayModeRequest {
  mode?: UiDisplayMode;
}

export interface UiDisplayModeResult {
  mode: UiDisplayMode;
  [key: string]: unknown;
}

function textFromUiBlock(block: unknown): string {
  if (typeof block !== "object" || block === null || !("text" in block)) {
    return "";
  }
  return textFromUiValue(block.text);
}

function textFromUiValue(value: unknown): string {
  const text = String(value);
  return value === null || value === undefined ? "" : text;
}
