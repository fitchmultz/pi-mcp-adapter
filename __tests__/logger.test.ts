import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger, writeTerminalError, writeTerminalLog, writeTerminalWarn } from "../logger.ts";

describe("Logger", () => {
  beforeEach(() => {
    const ignoreOutput = (): void => {
      // Observe console calls without writing test diagnostics.
    };
    vi.spyOn(console, "debug").mockImplementation(ignoreOutput);
    vi.spyOn(console, "log").mockImplementation(ignoreOutput);
    vi.spyOn(console, "warn").mockImplementation(ignoreOutput);
    vi.spyOn(console, "error").mockImplementation(ignoreOutput);
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
    logger
      .child({ server: "child-server" })
      .child({ session: "session123" })
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

  it("suppresses console output while any TUI owner is active unless MCP_UI_DEBUG is enabled", () => {
    const originalDebug = process.env.MCP_UI_DEBUG;
    delete process.env.MCP_UI_DEBUG;
    const ownerA = {};
    const ownerB = {};
    try {
      logger.setTuiActive(ownerA, true);
      logger.setTuiActive(ownerB, true);
      logger.debug("suppressed debug");
      logger.info("suppressed info");
      logger.warn("suppressed warn");
      logger.error("suppressed error", new Error("boom"));
      writeTerminalLog("suppressed raw log");
      writeTerminalWarn("suppressed raw warn");
      writeTerminalError("suppressed raw error");

      expect(console.debug).not.toHaveBeenCalled();
      expect(console.log).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();

      // Releasing only one owner keeps suppression active until the last TUI owner exits.
      logger.setTuiActive(ownerA, false);
      logger.warn("still suppressed");
      writeTerminalError("still suppressed raw error");
      expect(console.warn).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();

      process.env.MCP_UI_DEBUG = "1";
      logger.warn("debug override");
      writeTerminalError("debug raw error");
      expect(console.warn).toHaveBeenCalledWith("[MCP-UI:WARN] debug override");
      expect(console.error).toHaveBeenCalledWith("debug raw error");

      delete process.env.MCP_UI_DEBUG;
      logger.setTuiActive(ownerB, false);
      logger.warn("restored");
      writeTerminalLog("restored raw log");
      writeTerminalWarn("restored raw warn");
      writeTerminalError("restored raw error");
      expect(console.warn).toHaveBeenCalledWith("[MCP-UI:WARN] restored");
      expect(console.log).toHaveBeenCalledWith("restored raw log");
      expect(console.warn).toHaveBeenCalledWith("restored raw warn");
      expect(console.error).toHaveBeenCalledWith("restored raw error");
    } finally {
      logger.setTuiActive(ownerA, false);
      logger.setTuiActive(ownerB, false);
      if (originalDebug === undefined) {
        delete process.env.MCP_UI_DEBUG;
      } else {
        process.env.MCP_UI_DEBUG = originalDebug;
      }
    }
  });
});
