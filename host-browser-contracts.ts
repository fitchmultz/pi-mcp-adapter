import { z } from "zod";
import {
  McpUiHostContextSchema,
  McpUiToolInputNotificationSchema,
  McpUiToolResultNotificationSchema,
  McpUiToolCancelledNotificationSchema,
  type McpUiHostContext,
  type McpUiToolInputNotification,
  type McpUiToolResultNotification,
  type McpUiToolCancelledNotification,
} from "@modelcontextprotocol/ext-apps";

const hostConfigurationSchema = z.object({
  sessionToken: z.string(),
  uiResourceToken: z.string(),
  serverName: z.string(),
  toolName: z.string(),
  toolArgs: z.record(z.string(), z.unknown()),
  toolInputEventId: z.number().int().positive().optional(),
  hostContext: z.unknown(),
  allowAttribute: z.string(),
  requireToolConsent: z.boolean(),
});

export function readHostConfiguration(): z.infer<typeof hostConfigurationSchema> {
  const node = document.getElementById("host-configuration");
  if (!node) {
    throw new Error("Missing host configuration");
  }
  const value: unknown = JSON.parse(node.textContent);
  return hostConfigurationSchema.parse(value);
}

// Validate the original values, rather than returning schema-normalized copies:
// extension fields and unknown structuredContent must survive native forwarding.
export function isHostContext(value: unknown): value is McpUiHostContext {
  return McpUiHostContextSchema.safeParse(value).success;
}

export function isToolInput(value: unknown): value is McpUiToolInputNotification["params"] {
  return McpUiToolInputNotificationSchema.shape.params.safeParse(value).success;
}

function isToolResultInput(
  value: unknown,
): value is z.input<typeof McpUiToolResultNotificationSchema.shape.params> {
  return McpUiToolResultNotificationSchema.shape.params.safeParse(value).success;
}

export function readToolResult(value: unknown): McpUiToolResultNotification["params"] {
  if (!isToolResultInput(value)) {
    throw new Error("Invalid tool result");
  }
  return {
    ...value,
    content:
      value.content ??
      McpUiToolResultNotificationSchema.shape.params.shape.content.parse(value.content),
  };
}

export function isToolCancelled(value: unknown): value is McpUiToolCancelledNotification["params"] {
  return McpUiToolCancelledNotificationSchema.shape.params.safeParse(value).success;
}

export function readHostContext(value: unknown): McpUiHostContext {
  if (!isHostContext(value)) {
    throw new Error("Invalid host context");
  }
  return value;
}

export type HostConfiguration = ReturnType<typeof readHostConfiguration>;
