import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export type Feature = "gateway" | "script";
export type FeaturePolicy = Partial<Record<Feature, { eager?: boolean }>>;
export const featureNames: Record<Feature, string> = { gateway: "mcp", script: "mcp_script" };
export const featureKeys: Feature[] = ["gateway", "script"];
export const TOOL_SELECTION_ENTRY = "mcp-tool-selection";
const selectionSchema = Type.Object({ server: Type.String(), tool: Type.String() });
export type Selection = Static<typeof selectionSchema>;
const snapshotSchema = Type.Object({
  selected: Type.Array(selectionSchema),
  inactive: Type.Optional(Type.Array(selectionSchema)),
  features: Type.Optional(Type.Array(Type.Unknown())),
  inactiveFeatures: Type.Optional(Type.Array(Type.Unknown())),
});
export function isFeature(value: unknown): value is Feature {
  return value === "gateway" || value === "script";
}

/** Walk the native parent chain: siblings and older snapshots never override the first valid one. */
export function readToolSelection(
  ctx: ExtensionContext,
): Static<typeof snapshotSchema> | undefined {
  const manager = ctx.sessionManager;
  let id = manager.getLeafId();
  while (id !== null && id !== "") {
    const entry = manager.getEntry(id);
    if (!entry) {
      break;
    }
    if (entry.type === "custom" && entry.customType === TOOL_SELECTION_ENTRY) {
      const data: unknown = entry.data;
      if (Value.Check(snapshotSchema, data)) {
        return data;
      }
    }
    id = entry.parentId;
  }
  return;
}
