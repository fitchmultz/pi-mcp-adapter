const ALLOWED_OPEN_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** Allow only safe browser navigation schemes for MCP App open-link requests. */
export function isSafeOpenLinkUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_OPEN_LINK_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}
