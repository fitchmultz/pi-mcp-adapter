import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clients: [] as any[],
  transports: [] as any[],
  connectGate: null as null | { promise: Promise<void>; resolve(): void },
  connectError: null as Error | null,
  resolveGate: null as null | { promise: Promise<void>; resolve(): void },
  clientCreated: null as null | { promise: Promise<void>; resolve(): void },
  transportCreated: null as null | { promise: Promise<void>; resolve(): void },
  connectStarted: null as null | { promise: Promise<void>; resolve(): void },
  resolveStarted: null as null | { promise: Promise<void>; resolve(): void },
}));

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(res => { resolve = res; });
  return { promise, resolve };
}

vi.mock("@modelcontextprotocol/client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Client: vi.fn().mockImplementation(function (this: any) {
    this.setRequestHandler = vi.fn();
    this.setNotificationHandler = vi.fn();
    this.connect = vi.fn(async () => {
      mocks.connectStarted?.resolve();
      await mocks.connectGate?.promise;
      if (mocks.connectError) throw mocks.connectError;
    });
    this.listTools = vi.fn(async () => ({ tools: [] }));
    this.listResources = vi.fn(async () => ({ resources: [] }));
    this.close = vi.fn(async () => undefined);
    mocks.clients.push(this);
    mocks.clientCreated?.resolve();
  }),
  StreamableHTTPClientTransport: vi.fn(),
  SSEClientTransport: vi.fn(),
}));
vi.mock("@modelcontextprotocol/client/stdio", () => ({
  StdioClientTransport: vi.fn().mockImplementation(function (this: any) {
    this.send = vi.fn(async () => undefined);
    this.close = vi.fn(async () => undefined);
    mocks.transports.push(this);
    mocks.transportCreated?.resolve();
  }),
}));
vi.mock("../npx-resolver.ts", () => ({
  resolveNpxBinary: vi.fn(async () => {
    mocks.resolveStarted?.resolve();
    await mocks.resolveGate?.promise;
    return null;
  }),
}));

async function waitForConnectSetup(): Promise<void> {
  await mocks.clientCreated!.promise;
  await mocks.transportCreated!.promise;
  await mocks.connectStarted!.promise;
}

describe("MCP manager owner races", () => {
  beforeEach(() => {
    mocks.clients.length = 0;
    mocks.transports.length = 0;
    mocks.connectGate = null;
    mocks.connectError = null;
    mocks.resolveGate = null;
    mocks.clientCreated = gate();
    mocks.transportCreated = gate();
    mocks.connectStarted = gate();
    mocks.resolveStarted = gate();
  });

  it("closes a connection that finishes after owner shutdown before insertion", async () => {
    const { createMcpRuntimeOwner } = await import("../runtime-owner.ts");
    const { McpServerManager } = await import("../server-manager.ts");
    const connectGate = gate();
    mocks.connectGate = connectGate;
    const owner = createMcpRuntimeOwner();
    const manager = new McpServerManager("/tmp/session");
    manager.setRuntimeSignal(owner.signal);

    const connecting = manager.connect("demo", { command: "node", args: ["server.js"] });
    await waitForConnectSetup();
    await owner.stop("reload");
    connectGate.resolve();

    await expect(connecting).rejects.toThrow("reload");
    expect(manager.getAllConnections().size).toBe(0);
    expect(mocks.clients[0].close).not.toHaveBeenCalled();
    expect(mocks.transports[0].close).toHaveBeenCalledTimes(1);
  });

  it("close aborts an in-flight connect and prevents late insertion", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const connectGate = gate();
    mocks.connectGate = connectGate;
    const manager = new McpServerManager("/tmp/session");
    const connecting = manager.connect("demo", { command: "node", args: ["server.js"] });
    await waitForConnectSetup();
    const closing = manager.close("demo");
    await expect(closing).resolves.toBeUndefined();
    connectGate.resolve();
    await expect(connecting).rejects.toThrow("connection demo was closed");
    expect(manager.getConnection("demo")).toBeUndefined();
  });

  it("closeAll aborts pending connects and settles without late insertion", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const connectGate = gate();
    mocks.connectGate = connectGate;
    const manager = new McpServerManager("/tmp/session");
    const connecting = manager.connect("demo", { command: "node", args: ["server.js"] });
    await waitForConnectSetup();
    const closeAll = manager.closeAll();
    await expect(closeAll).resolves.toBeUndefined();
    connectGate.resolve();
    await expect(connecting).rejects.toThrow();
    expect(manager.getAllConnections().size).toBe(0);
  });

  it("surfaces transport cleanup failures from an aborted pending connect", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const connectGate = gate();
    mocks.connectGate = connectGate;
    const manager = new McpServerManager("/tmp/session");
    const connecting = manager.connect("demo", { command: "node", args: ["server.js"] });
    await waitForConnectSetup();
    mocks.transports[0].close = vi.fn(async () => { throw new Error("transport close failed"); });

    const closeAll = manager.closeAll();
    connectGate.resolve();

    await expect(closeAll).rejects.toThrow("MCP manager cleanup failed");
    await expect(connecting).rejects.toThrow("MCP connection abort cleanup failed");
  });

  it("surfaces client cleanup failures after a non-abort setup error", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const connectGate = gate();
    mocks.connectGate = connectGate;
    mocks.connectError = new Error("connect failed");
    const manager = new McpServerManager("/tmp/session");
    const connecting = manager.connect("demo", { command: "node", args: ["server.js"] });
    await waitForConnectSetup();
    mocks.clients[0].close = vi.fn(async () => { throw new Error("client close failed"); });
    connectGate.resolve();

    await expect(connecting).rejects.toThrow("MCP connection setup failed");
    expect(mocks.clients[0].close).toHaveBeenCalledTimes(1);
  });

  it("rejects connections after terminal manager shutdown", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager("/tmp/session");

    await manager.closeAll();

    await expect(manager.connect("demo", { command: "node", args: ["server.js"] }))
      .rejects.toThrow("MCP server manager is closed");
    expect(mocks.clients).toHaveLength(0);
    expect(mocks.transports).toHaveLength(0);
  });

  it("does not create a stdio transport when npx resolution is cancelled", async () => {
    const { createMcpRuntimeOwner } = await import("../runtime-owner.ts");
    const { McpServerManager } = await import("../server-manager.ts");
    const resolveGate = gate();
    mocks.resolveGate = resolveGate;
    const owner = createMcpRuntimeOwner();
    const manager = new McpServerManager("/tmp/session");
    manager.setRuntimeSignal(owner.signal);

    const connecting = manager.connect("demo", { command: "npx", args: ["-y", "demo"] });
    await mocks.clientCreated!.promise;
    await mocks.resolveStarted!.promise;
    expect(mocks.transports).toHaveLength(0);
    await owner.stop("shutdown");
    resolveGate.resolve();

    await expect(connecting).rejects.toThrow("shutdown");
    expect(mocks.transports).toHaveLength(0);
  });

  it.each(["abort", "clear-config"] as const)("cancels URL elicitation when %s happens during the handler import", async change => {
    const { UrlElicitationRequiredError } = await import("@modelcontextprotocol/client");
    const { McpServerManager } = await import("../server-manager.ts");
    const controller = new AbortController();
    const ui = {
      select: vi.fn(async () => "Decline"),
      input: vi.fn(),
      notify: vi.fn(),
    };
    const manager = new McpServerManager();
    manager.setRuntimeSignal(controller.signal);
    manager.setElicitationConfig({ allowUrl: true, ui: ui as any });
    try {
      const pending = manager.handleUrlElicitationRequired("demo", new UrlElicitationRequiredError([{
        mode: "url",
        message: "Connect your account",
        elicitationId: "cancel-during-import",
        url: "https://example.test/connect",
      }]));
      // Even a cached dynamic import yields. Change ownership before it resumes,
      // rather than relying on a timer or a guessed number of microtasks.
      if (change === "abort") controller.abort(new Error("owner stopped during import"));
      else manager.setElicitationConfig(undefined);

      await expect(pending).resolves.toBe("cancel");
      expect(ui.select).not.toHaveBeenCalled();
      expect(ui.input).not.toHaveBeenCalled();
      expect(ui.notify).not.toHaveBeenCalled();
    } finally {
      await manager.closeAll();
    }
  });
});
