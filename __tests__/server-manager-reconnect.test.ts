import { beforeEach, describe, expect, it, vi } from "vitest";

type TransportOptions = {
  requestInit?: { headers?: Record<string, string> };
};

type HttpTransportMock = {
  url: URL;
  options: TransportOptions;
  close: () => Promise<void>;
};

const mocks = vi.hoisted(() => ({
  clients: [] as any[],
  connectGate: undefined as Promise<void> | undefined,
  httpTransports: [] as HttpTransportMock[],
}));

vi.mock("@modelcontextprotocol/client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Client: vi.fn().mockImplementation((info: unknown, options: unknown) => {
    const client: any = {
      info,
      options,
      onclose: undefined,
      setRequestHandler: vi.fn(),
      setNotificationHandler: vi.fn(),
      connect: vi.fn(async () => { await mocks.connectGate; }),
      listTools: vi.fn(async () => ({ tools: [] })),
      listResources: vi.fn(async () => ({ resources: [] })),
      close: vi.fn(async () => undefined),
    };
    mocks.clients.push(client);
    return client;
  }),
  StreamableHTTPClientTransport: vi.fn().mockImplementation((url: URL, options: TransportOptions) => {
    const transport = { url, options, send: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    mocks.httpTransports.push(transport);
    return transport;
  }),
  SSEClientTransport: vi.fn(),
}));

vi.mock("@modelcontextprotocol/client/stdio", () => ({
  StdioClientTransport: vi.fn(),
}));

vi.mock("../npx-resolver.ts", () => ({
  resolveNpxBinary: vi.fn(async () => null),
}));

describe("McpServerManager connections", () => {
  beforeEach(() => {
    mocks.clients.length = 0;
    mocks.httpTransports.length = 0;
    mocks.connectGate = undefined;
  });

  const def = { url: "https://example.test/mcp" };

  it("rejects a connection closed during optional discovery and allows a fresh attempt", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    let releaseConnect!: () => void;
    mocks.connectGate = new Promise<void>(resolve => { releaseConnect = resolve; });
    const connecting = manager.connect("remote", def);

    try {
      await vi.waitFor(() => expect(mocks.clients).toHaveLength(1));
      const client = mocks.clients[0];
      client.getServerCapabilities = () => ({ resources: {} });
      client.listResources.mockImplementation(async () => {
        client.onclose();
        throw new Error("Connection closed");
      });
      releaseConnect();

      await expect(connecting).rejects.toThrow("closed while connecting");
      expect(manager.getConnection("remote")).toBeUndefined();
      expect((await manager.connect("remote", def)).status).toBe("connected");
      expect(mocks.clients).toHaveLength(2);
    } finally {
      releaseConnect();
      await manager.closeAll();
    }
  });

  it("keeps a shared initial connection alive when its first caller cancels", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    let releaseConnect!: () => void;
    mocks.connectGate = new Promise<void>(resolve => { releaseConnect = resolve; });
    const controller = new AbortController();
    const reason = new Error("stop waiting");

    const first = manager.connect("remote", def, controller.signal);
    const second = manager.connect("remote", def).catch(error => error);
    try {
      controller.abort(reason);
      await expect(first).rejects.toBe(reason);
      const third = manager.connect("remote", def).catch(error => error);
      expect(mocks.clients).toHaveLength(1);

      releaseConnect();
      const connection = await second;
      expect(connection).toBe(await third);
      expect(connection).toBe(manager.getConnection("remote"));
      expect(connection.status).toBe("connected");
    } finally {
      releaseConnect();
      await manager.closeAll();
    }
  });

  it("lets a new caller connect after the sole waiter cancels", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    let releaseConnect!: () => void;
    mocks.connectGate = new Promise<void>(resolve => { releaseConnect = resolve; });
    const controller = new AbortController();
    const first = manager.connect("remote", def, controller.signal);

    try {
      controller.abort(new Error("stop waiting"));
      await expect(first).rejects.toThrow("stop waiting");
      const next = manager.connect("remote", def);
      releaseConnect();
      expect((await next).status).toBe("connected");
      expect(mocks.clients).toHaveLength(2);
    } finally {
      releaseConnect();
      await manager.closeAll();
    }
  });

  it("is single-flight: concurrent reconnects for the same server share one underlying reconnect", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    const stale = await manager.connect("remote", def);
    mocks.clients.length = 0;
    mocks.httpTransports.length = 0;

    const [c1, c2] = await Promise.all([
      manager.reconnect("remote", def, stale),
      manager.reconnect("remote", def, stale),
    ]);

    expect(c1).toBe(c2);
    expect(mocks.clients.length).toBe(1);
    expect(manager.getConnection("remote")).toBe(c1);
  });

  it("identity guard: never tears down a connection it did not prove stale", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    const stale = await manager.connect("remote", def);
    await manager.close("remote");
    const fresh = await manager.connect("remote", def);

    mocks.clients.length = 0;
    mocks.httpTransports.length = 0;

    // A caller that captured `stale` before the close/reconnect cycle above
    // (e.g. a concurrent tool call that lost the race) asks to reconnect
    // from that now-superseded connection.
    const result = await manager.reconnect("remote", def, stale);

    expect(result).toBe(fresh);
    expect(fresh.client.close).not.toHaveBeenCalled();
    expect(mocks.clients.length).toBe(0); // no new connection attempted
    expect(manager.getConnection("remote")).toBe(fresh);
  });

  it("keeps a shared reconnect alive when one caller aborts waiting", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    const stale = await manager.connect("remote", def);
    let releaseConnect!: () => void;
    mocks.connectGate = new Promise<void>(resolve => { releaseConnect = resolve; });
    const reason = new Error("stop waiting");
    const controller = new AbortController();

    const first = manager.reconnect("remote", def, stale, controller.signal);
    controller.abort(reason);
    await expect(first).rejects.toBe(reason);

    const second = manager.reconnect("remote", def, stale);
    releaseConnect();
    const fresh = await second;
    expect(fresh).not.toBe(stale);
    expect(manager.getConnection("remote")).toBe(fresh);
  });

  it("carries in-flight work from the stale connection to the fresh connection", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    const stale = await manager.connect("remote", def);
    stale.inFlight = 2;

    const fresh = await manager.reconnect("remote", def, stale);

    expect(fresh).not.toBe(stale);
    expect(fresh.inFlight).toBe(2);
    expect(manager.getConnection("remote")).toBe(fresh);
  });

  it("identity guard: a stale connection's late onclose does not clobber the fresh connection's status", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    const stale = await manager.connect("remote", def);
    const staleClient = mocks.clients[0];

    mocks.clients.length = 0;
    mocks.httpTransports.length = 0;

    const fresh = await manager.reconnect("remote", def, stale);
    const freshClient = mocks.clients[0];

    expect(fresh).not.toBe(stale);
    expect(manager.getConnection("remote")).toBe(fresh);

    // Late close event from the old (already-replaced) client/transport.
    staleClient.onclose?.();
    expect(fresh.status).toBe("connected");
    expect(manager.getConnection("remote")).toBe(fresh);

    // A close on the current connection's own client still works normally.
    freshClient.onclose?.();
    expect(fresh.status).toBe("closed");
  });
});
