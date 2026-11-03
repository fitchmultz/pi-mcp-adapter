function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Inspect object properties without trusting their values. Arrays retain their indexed keys. */
export function asObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return isObjectRecord(value) ? value : undefined;
}

export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
