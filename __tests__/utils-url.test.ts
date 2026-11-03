import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { resolveServerUrl } from "../utils.ts";

function thrownError(operation: () => unknown): Error {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  assert.fail("Expected the operation to throw");
}

describe("server URL validation", () => {
  it.each(["invalid MCP URL", "http://", "https://exa mple.test"])(
    "retains the native invalid-URL cause for %s",
    (input) => {
      const native = thrownError(() => new URL(input));
      const actual = thrownError(() => resolveServerUrl({ url: input }));
      expect(actual.message).toBe(
        `Invalid MCP server URL after environment interpolation: ${input}`,
      );
      expect(actual.cause).toBeInstanceOf(TypeError);
      expect(actual.cause).toEqual(native);
      assert.ok(actual.cause instanceof Error);
      assert.ok("code" in actual.cause && "input" in actual.cause);
      expect(actual.cause.code).toBe("ERR_INVALID_URL");
      expect(actual.cause.input).toBe(input);
    },
  );

  it("validates without canonicalizing valid configured bytes", () => {
    const input = "https://EXAMPLE.test:443/a/../b?query=%2f";
    expect(new URL(input).href).not.toBe(input);
    expect(resolveServerUrl({ url: input })).toBe(input);
  });
});
