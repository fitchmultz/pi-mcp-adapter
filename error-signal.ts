/**
 * Classify returned MCP execution failures for Pi's native result-level isError.
 *
 * A failed MCP tool call is *returned* (not thrown), tagged `details.error: "tool_error"` (the server
 * returned an error result) or `"call_failed"` (the call itself threw and was caught).
 * Spread this onto the returned result without replacing human or structured content.
 *
 * Other results can set `isError` at their source, such as `server_backoff` before dispatch.
 * A `details.error` code alone (for example `auth_required` or search feedback) does not set it.
 */
export function toolErrorOverride(details: unknown): { isError: true } | undefined {
  if (details !== null && typeof details === "object" && "error" in details) {
    const code = details.error;
    if (code === "tool_error" || code === "call_failed") {
      return { isError: true };
    }
  }
  return undefined;
}
