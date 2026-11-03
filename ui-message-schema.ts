import { ContentBlockSchema } from "@modelcontextprotocol/core";
import { z } from "zod";

// Runtime owner of the UI message contracts. Values load Zod, so only the lazily
// loaded UI server imports them; ui-message-types.ts re-exports the types only.
const uiMessageParamsSchema = z.looseObject({
  role: z.string().exactOptional(),
  content: z.array(z.unknown()).exactOptional(),
  type: z.enum(["prompt", "notify", "intent", "message"]).exactOptional(),
  message: z.string().exactOptional(),
  prompt: z.string().exactOptional(),
  intent: z.string().exactOptional(),
  params: z.record(z.string(), z.unknown()).exactOptional(),
});

/** Legacy MCP UI and native AppBridge message params, including extension fields. */
export type UiMessageParams = z.input<typeof uiMessageParamsSchema>;

const uiModelContextParamsSchema = z.looseObject({
  content: z.array(ContentBlockSchema).exactOptional(),
  structuredContent: z.record(z.string(), z.unknown()).exactOptional(),
});

// Validate originals rather than returning schema copies: arbitrary JSON keys,
// their order and opaque values must reach callbacks and history unchanged.
export function isUiMessageParams(value: unknown): value is UiMessageParams {
  return uiMessageParamsSchema.safeParse(value).success;
}

export function isUiModelContextParams(
  value: unknown,
): value is z.input<typeof uiModelContextParamsSchema> {
  return uiModelContextParamsSchema.safeParse(value).success;
}
