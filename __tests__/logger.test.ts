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

  it("routes warnings and errors to ctx.ui.notify while muting stdout/debug in UI mode", () => {
    const originalDebug = process.env.MCP_UI_DEBUG;
    delete process.env.MCP_UI_DEBUG;
    const ownerA = {};
    const ownerB = {};
    const rpcOwner = {};
    const notifyA = vi.fn<(message: string, level?: "info" | "warning" | "error") => void>();
    const notifyB = vi.fn<(message: string, level?: "info" | "warning" | "error") => void>();
    try {
      logger.setUiHost(ownerA, { notify: notifyA });
      logger.setUiHost(ownerB, { notify: notifyB });
      logger.debug("suppressed debug");
      logger.info("suppressed info");
      logger.warn("routed warn");
      logger.error("routed error", new Error("boom"));
      writeTerminalLog("routed raw log");
      writeTerminalWarn("routed raw warn");
      writeTerminalError("routed raw error");

      expect(console.debug).not.toHaveBeenCalled();
      expect(console.log).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();
      expect(notifyA).not.toHaveBeenCalled();
      expect(notifyB).toHaveBeenCalledWith("[MCP-UI:WARN] routed warn", "warning");
      expect(notifyB).toHaveBeenCalledWith("[MCP-UI:ERROR] routed error: boom", "error");
      expect(notifyB).toHaveBeenCalledWith("routed raw log", "info");
      expect(notifyB).toHaveBeenCalledWith("routed raw warn", "warning");
      expect(notifyB).toHaveBeenCalledWith("routed raw error", "error");

      notifyB.mockClear();
      // Removing ownerA keeps routing active through ownerB's UI notifier.
      logger.setUiHost(ownerA, null);
      logger.warn("still routed");
      writeTerminalError("still routed error");
      expect(notifyB).toHaveBeenCalledWith("[MCP-UI:WARN] still routed", "warning");
      expect(notifyB).toHaveBeenCalledWith("still routed error", "error");
      expect(console.warn).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();

      process.env.MCP_UI_DEBUG = "1";
      logger.info("debug info mirror");
      logger.warn("debug override");
      writeTerminalLog("debug raw log");
      writeTerminalWarn("debug raw warn");
      writeTerminalError("debug raw error");
      expect(console.log).not.toHaveBeenCalled();
      expect(console.debug).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith("[MCP-UI] debug info mirror");
      expect(console.error).toHaveBeenCalledWith("[MCP-UI:WARN] debug override");
      expect(console.error).toHaveBeenCalledWith("debug raw log");
      expect(console.warn).toHaveBeenCalledWith("debug raw warn");
      expect(console.error).toHaveBeenCalledWith("debug raw error");

      delete process.env.MCP_UI_DEBUG;
      logger.setUiHost(ownerB, null);
      // An owner without ui.notify (e.g., headless RPC fallback) keeps warn/error on stderr only.
      logger.setUiHost(rpcOwner, {});
      logger.info("rpc muted stdout");
      logger.error("rpc stderr error", new Error("failed"));
      writeTerminalError("rpc raw stderr error");
      expect(console.log).not.toHaveBeenCalled();
      expect(console.debug).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        "[MCP-UI:ERROR] rpc stderr error",
        expect.any(Error),
      );
      expect(console.error).toHaveBeenCalledWith("rpc raw stderr error");

      logger.setUiHost(rpcOwner, null);
      logger.warn("restored");
      writeTerminalLog("restored raw log");
      writeTerminalWarn("restored raw warn");
      writeTerminalError("restored raw error");
      expect(console.warn).toHaveBeenCalledWith("[MCP-UI:WARN] restored");
      expect(console.log).toHaveBeenCalledWith("restored raw log");
      expect(console.warn).toHaveBeenCalledWith("restored raw warn");
      expect(console.error).toHaveBeenCalledWith("restored raw error");
    } finally {
      logger.setUiHost(ownerA, null);
      logger.setUiHost(ownerB, null);
      logger.setUiHost(rpcOwner, null);
      if (originalDebug === undefined) {
        delete process.env.MCP_UI_DEBUG;
      } else {
        process.env.MCP_UI_DEBUG = originalDebug;
      }
    }
  });
});
