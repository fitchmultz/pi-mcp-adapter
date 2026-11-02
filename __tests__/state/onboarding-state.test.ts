import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("onboarding state", () => {
  const originalHome = process.env.HOME;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  let home: string;

  beforeEach(() => {
    delete process.env.PI_CODING_AGENT_DIR;
    home = mkdtempSync(join(tmpdir(), "pi-mcp-onboarding-home-"));
    process.env.HOME = home;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("returns the default state when no file exists", async () => {
    const { loadOnboardingState, getOnboardingStatePath } =
      await import("../../onboarding-state.ts");

    expect(loadOnboardingState()).toEqual({
      version: 1,
      sharedConfigHintShown: false,
      setupCompleted: false,
    });
    expect(existsSync(getOnboardingStatePath())).toBe(false);
  });

  it("persists hint and setup completion state", async () => {
    const {
      markSharedConfigHintShown,
      markSetupCompleted,
      loadOnboardingState,
      getOnboardingStatePath,
    } = await import("../../onboarding-state.ts");

    markSharedConfigHintShown();
    markSetupCompleted();

    expect(loadOnboardingState()).toEqual({
      version: 1,
      sharedConfigHintShown: true,
      setupCompleted: true,
    });

    const raw: unknown = JSON.parse(readFileSync(getOnboardingStatePath(), "utf-8"));
    expect(raw).toMatchObject({ sharedConfigHintShown: true, setupCompleted: true });
  });
});
