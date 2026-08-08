import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.ts";

describe("Logger", () => {
  beforeEach(() => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    logger.setLevel("debug");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("respects the minimum log level", () => {
    logger.setLevel("warn");
    logger.debug("debug message");
    logger.info("info message");
    logger.warn("warn message");
    logger.error("error message");

    expect(console.debug).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledOnce();
  });

  it("writes each log level to its console method", () => {
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    expect(console.debug).toHaveBeenCalledWith("[MCP-UI:DEBUG] d");
    expect(console.log).toHaveBeenCalledWith("[MCP-UI] i");
    expect(console.warn).toHaveBeenCalledWith("[MCP-UI:WARN] w");
    expect(console.error).toHaveBeenCalledWith("[MCP-UI:ERROR] e", "");
  });

  it("formats call and child context", () => {
    logger.info("direct", { server: "test-server", tool: "test-tool" });
    logger.child({ server: "child-server" }).child({ session: "session123" })
      .info("child", { tool: "child-tool" });

    expect(console.log).toHaveBeenNthCalledWith(
      1,
      "[MCP-UI] direct (server=test-server, tool=test-tool)",
    );
    expect(console.log).toHaveBeenNthCalledWith(
      2,
      "[MCP-UI] child (server=child-server, session=session123, tool=child-tool)",
    );
  });

  it("passes errors to console", () => {
    const error = new Error("test error");
    logger.error("something failed", error, { server: "test" });

    expect(console.error).toHaveBeenCalledWith(
      "[MCP-UI:ERROR] something failed (server=test)",
      error,
    );
  });
});
