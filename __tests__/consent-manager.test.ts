import { describe, expect, it } from "vitest";
import { ConsentManager, resolveUiToolConsent } from "../consent-manager.ts";

describe("ConsentManager", () => {
  it("requires consent per server", () => {
    const manager = new ConsentManager();
    expect(manager.requiresPrompt("server-a")).toBe(true);

    manager.registerDecision("server-a", true);
    expect(manager.requiresPrompt("server-a")).toBe(false);
    expect(manager.requiresPrompt("server-b")).toBe(true);
    expect(() => manager.ensureApproved("server-a")).not.toThrow();
  });

  it("distinguishes missing and denied consent", () => {
    const manager = new ConsentManager();
    expect(() => manager.ensureApproved("server-a")).toThrow(
      'Tool call approval required for "server-a"',
    );

    manager.registerDecision("server-a", false);
    expect(manager.requiresPrompt("server-a")).toBe(true);
    expect(() => manager.ensureApproved("server-a")).toThrow(
      'Tool calls for "server-a" were denied for this session',
    );
  });

  it("replaces earlier decisions", () => {
    const manager = new ConsentManager();
    manager.registerDecision("server-a", false);
    manager.registerDecision("server-a", true);
    expect(() => manager.ensureApproved("server-a")).not.toThrow();

    manager.registerDecision("server-a", false);
    expect(() => manager.ensureApproved("server-a")).toThrow(/denied/);
  });

  it("supports always and never policies alongside once-per-server", () => {
    const manager = new ConsentManager();
    expect(manager.requiresPrompt("server-a", "always")).toBe(false);
    expect(() => manager.ensureApproved("server-a", "always")).not.toThrow();

    manager.registerDecision("server-a", false);
    expect(() => manager.ensureApproved("server-a", "always")).not.toThrow();

    manager.registerDecision("server-a", true);
    expect(manager.requiresPrompt("server-a", "never")).toBe(false);
    expect(() => manager.ensureApproved("server-a", "never")).toThrow(
      'Tool calls from UI are denied by configuration for "server-a"',
    );
  });

  it("resolves uiToolConsent with per-server precedence over global settings", () => {
    expect(resolveUiToolConsent(undefined, "datadog")).toBe("once-per-server");
    expect(
      resolveUiToolConsent(
        { mcpServers: { datadog: {} }, settings: { uiToolConsent: "always" } },
        "datadog",
      ),
    ).toBe("always");
    expect(
      resolveUiToolConsent(
        {
          mcpServers: { datadog: { uiToolConsent: "never" } },
          settings: { uiToolConsent: "always" },
        },
        "datadog",
      ),
    ).toBe("never");
  });
});
