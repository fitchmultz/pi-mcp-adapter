import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { executeInstructions, executeList } from "../../proxy-modes.ts";
import type { McpExtensionState } from "../../state.ts";
import { createTestState } from "../test-state.ts";

const SHORT_INSTRUCTIONS = "Call read_skill with a skill name before answering.";
const LONG_INSTRUCTIONS = `Available skills: ${Array.from({ length: 40 }, (_, i) => `skill-${i}`).join(", ")}. Call read_skill with a skill name to load one.`;
const fixture = fileURLToPath(new URL("../fixtures/mcp-code-server.mjs", import.meta.url));
const definition = { command: process.execPath, args: [fixture] };

function createState(
  overrides: { instructions?: string; noTools?: boolean } = {},
): McpExtensionState {
  return createTestState({
    config: { mcpServers: { demo: definition } },
    toolMetadata: new Map([
      [
        "demo",
        overrides.noTools === true
          ? []
          : [
              {
                name: "demo_read_skill",
                originalName: "read_skill",
                description: "Read a skill listed in this server's instructions",
              },
            ],
      ],
    ]),
    serverInstructions: new Map(
      overrides.instructions !== undefined && overrides.instructions !== ""
        ? [["demo", overrides.instructions]]
        : [],
    ),
  });
}

function firstText(result: ReturnType<typeof executeList>): string {
  const content = result.content[0];
  assert.ok(content?.type === "text", "expected text content");
  return content.text;
}

describe("proxy instructions", () => {
  it("includes short server instructions in full in the listing", () => {
    const result = executeList(createState({ instructions: SHORT_INSTRUCTIONS }), "demo");

    expect(firstText(result)).toContain(`Server instructions:\n${SHORT_INSTRUCTIONS}`);
    expect(firstText(result)).not.toContain('mcp({ action: "instructions"');
    expect(result.details).toMatchObject({ mode: "list", hasInstructions: true });
  });

  it("truncates long instructions in the listing and points at the instructions mode", () => {
    const result = executeList(createState({ instructions: LONG_INSTRUCTIONS }), "demo");

    expect(firstText(result)).toContain("Server instructions:");
    expect(firstText(result)).not.toContain(LONG_INSTRUCTIONS);
    expect(firstText(result)).toContain(
      'Use mcp({ action: "instructions", server: "demo" }) for the full text.',
    );
  });

  it("leaves the listing unchanged when a server has no instructions", () => {
    const result = executeList(createState(), "demo");

    expect(firstText(result)).not.toContain("Server instructions");
    expect(result.details).toMatchObject({ mode: "list", hasInstructions: false });
  });

  it("includes instructions for connected and cached servers with no visible tools", async () => {
    const state = createState({ instructions: SHORT_INSTRUCTIONS, noTools: true });
    try {
      await state.manager.connect("demo", definition);
      const connected = executeList(state, "demo");
      const cached = executeList(
        createState({ instructions: SHORT_INSTRUCTIONS, noTools: true }),
        "demo",
      );

      expect(firstText(connected)).toContain('Server "demo" has no tools');
      expect(firstText(connected)).toContain(`Server instructions:\n${SHORT_INSTRUCTIONS}`);
      expect(connected.details).toMatchObject({ mode: "list", count: 0, hasInstructions: true });
      expect(firstText(cached)).toContain('Server "demo" has no cached tools');
      expect(firstText(cached)).toContain(`Server instructions:\n${SHORT_INSTRUCTIONS}`);
      expect(cached.details).toMatchObject({ mode: "list", count: 0, hasInstructions: true });
    } finally {
      await state.manager.closeAll();
    }
  });

  it("returns the full instructions text", () => {
    const result = executeInstructions(createState({ instructions: LONG_INSTRUCTIONS }), "demo");

    expect(firstText(result)).toBe(`demo instructions:\n\n${LONG_INSTRUCTIONS}`);
    expect(result.details).toMatchObject({
      mode: "instructions",
      server: "demo",
      length: LONG_INSTRUCTIONS.length,
    });
  });

  it("reports unknown servers", () => {
    const result = executeInstructions(createState(), "missing");

    expect(firstText(result)).toContain('Server "missing" not found');
    expect(result.details).toMatchObject({ mode: "instructions", error: "not_found" });
  });

  it("reports connected servers that provide no instructions", async () => {
    const state = createState();
    try {
      await state.manager.connect("demo", definition);
      const result = executeInstructions(state, "demo");
      expect(firstText(result)).toBe('Server "demo" does not provide instructions.');
      expect(result.details).toMatchObject({ mode: "instructions", error: "no_instructions" });
    } finally {
      await state.manager.closeAll();
    }
  });

  it("suggests connecting when no instructions are cached", () => {
    const result = executeInstructions(createState(), "demo");

    expect(firstText(result)).toContain('mcp({ action: "connect", server: "demo" })');
    expect(result.details).toMatchObject({ mode: "instructions", error: "not_connected" });
  });
});
