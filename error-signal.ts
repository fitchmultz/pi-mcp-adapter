/**
 * Classify returned MCP execution failures for Pi's native result-level isError.
 *
 * A failed MCP tool call is *returned* (not thrown), tagged `details.error: "tool_error"` (the server
 * returned an error result) or `"call_failed"` (the call itself threw and was caught).
 * Spread this onto the returned result without replacing human or structured content.
 *
 * Limited to those two codes: the adapter's other `details.error` values (`auth_required`, connection
 * states, search/validation feedback, ...) are not failed tool calls, so they get no override.
 */
export function toolErrorOverride(details: unknown): { isError: true } | undefined {
  if (details && typeof details === "object" && "error" in details) {
    const code = (details as { error?: unknown }).error;
    if (code === "tool_error" || code === "call_failed") {
      return { isError: true };
    }
  }
  return undefined;
}
