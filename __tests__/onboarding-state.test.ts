import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("onboarding state", () => {
  const originalHome = process.env.HOME;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

  beforeEach(() => {
    delete process.env.PI_CODING_AGENT_DIR;
    vi.resetModules();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  });

  it("returns the default state when no file exists", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "pi-mcp-onboarding-home-"));
    const { loadOnboardingState, getOnboardingStatePath } = await import("../onboarding-state.ts");

    expect(loadOnboardingState()).toEqual({
      version: 1,
      sharedConfigHintShown: false,
      setupCompleted: false,
    });
    expect(existsSync(getOnboardingStatePath())).toBe(false);
  });

  it("persists hint and setup completion state", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "pi-mcp-onboarding-home-"));
    const {
      markSharedConfigHintShown,
      markSetupCompleted,
      loadOnboardingState,
      getOnboardingStatePath,
    } = await import("../onboarding-state.ts");

    markSharedConfigHintShown();
    markSetupCompleted();

    expect(loadOnboardingState()).toEqual({
      version: 1,
      sharedConfigHintShown: true,
      setupCompleted: true,
    });

    const raw = JSON.parse(readFileSync(getOnboardingStatePath(), "utf-8"));
    expect(raw.sharedConfigHintShown).toBe(true);
    expect(raw.setupCompleted).toBe(true);
  });
});
