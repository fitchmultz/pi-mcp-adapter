/** A JSON object boundary, not a claim about any SDK class or domain schema. */
export function isUiJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
