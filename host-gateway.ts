import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type * as Proxy from "./proxy-modes.ts";
import type { McpAdapterHost, HostToolArguments } from "./host-contract.ts";
import type { McpAdapterOptions, McpOperationContext } from "./types.ts";
import type { McpExtensionState } from "./state.ts";
import { prepareGatewayArguments, type GatewayArguments } from "./gateway-arguments.ts";
import {
  guardMcpOutput,
  guardedMcpDetails,
  resolveMcpOutputGuardOptions,
  readMcpResult,
} from "./mcp-output-guard.ts";

type GatewayResult = Awaited<ReturnType<typeof Proxy.executeCall>>;
type Dispatch = {
  proxy: typeof Proxy;
  ready: McpExtensionState;
  signal: AbortSignal | undefined;
  toolCallId: string;
  getPiTools: () => ReturnType<ExtensionAPI["getAllTools"]>;
  beforeDispatch: Parameters<typeof Proxy.executeCall>[7];
  sync: () => void;
};

function required(value: string | undefined, action: string, field: string): string {
  if (value === undefined) {
    throw new Error(`${action} requires ${field}`);
  }
  return value;
}

async function present(ready: McpExtensionState, result: GatewayResult): Promise<GatewayResult> {
  const guarded = await guardMcpOutput(
    result.content,
    resolveMcpOutputGuardOptions(ready.config.settings, ready.outputDirectory),
  );
  return {
    content: guarded.content,
    details: { ...result.details, ...guardedMcpDetails(guarded) },
  };
}

function authComplete(
  { proxy, ready, signal }: Dispatch,
  params: GatewayArguments,
): Promise<GatewayResult> {
  const input = params.args?.redirectUrl ?? params.args?.code ?? params.args?.input;
  if (input !== undefined && (typeof input !== "string" || input.trim().length === 0)) {
    throw new Error("auth-complete requires a non-empty redirectUrl, code, or input");
  }
  return proxy.executeAuthComplete(
    ready,
    required(params.server, params.action, "server"),
    input,
    signal,
  );
}

async function dispatchGateway(
  params: GatewayArguments,
  context: Dispatch,
): Promise<GatewayResult> {
  const { proxy, ready, signal, toolCallId, getPiTools, beforeDispatch } = context;
  const server = () => required(params.server, params.action, "server");
  const tool = () => required(params.tool, params.action, "tool");
  switch (params.action) {
    case "ui-messages":
      return proxy.executeUiMessages(ready);
    case "auth-start":
      return proxy.executeAuthStart(ready, server(), signal);
    case "auth-complete":
      return authComplete(context, params);
    case "call":
      return proxy.executeCall(
        ready,
        tool(),
        params.args,
        params.server,
        getPiTools,
        signal,
        { toolCallId },
        beforeDispatch,
      );
    case "connect": {
      const result = await proxy.executeConnect(
        ready,
        server(),
        signal,
        params.limit,
        params.offset,
      );
      context.sync();
      return present(ready, result);
    }
    case "describe":
      return present(ready, proxy.executeDescribe(ready, tool(), params.server));
    case "instructions":
      return present(ready, proxy.executeInstructions(ready, server()));
    case "search":
      return present(
        ready,
        proxy.executeSearch(
          ready,
          required(params.query, params.action, "query"),
          params.server,
          params.includeSchemas,
          params.limit,
          params.offset,
        ),
      );
    case "list":
      return present(ready, proxy.executeList(ready, server(), params.limit, params.offset));
    case "resources":
      return present(
        ready,
        await (
          await import("./resource-tools.ts")
        ).executeResourceList(ready, server(), params.limit, params.offset, signal),
      );
    case "read-resource":
      return (await import("./resource-tools.ts")).executeResourceRead(
        ready,
        server(),
        required(params.uri, params.action, "uri"),
        signal,
        { toolCallId },
        beforeDispatch,
      );
    case "read-result":
      return readResult(ready, params);
    case "status":
      return present(ready, proxy.executeStatus(ready));
  }
}

function readResult(ready: McpExtensionState, params: GatewayArguments) {
  return readMcpResult(
    {
      ref: required(params.ref, params.action, "ref"),
      ...(params.path !== undefined ? { path: params.path } : {}),
      ...(params.fields ? { fields: params.fields } : {}),
      ...(params.offset !== undefined ? { offset: params.offset } : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
    },
    resolveMcpOutputGuardOptions(ready.config.settings, ready.outputDirectory),
  );
}

async function beforeGateway(
  host: McpAdapterHost,
  hook: McpAdapterOptions["beforeExecute"],
  call: { id: string; ctx: ExtensionContext; action: GatewayArguments["action"] },
): Promise<void> {
  if (!hook || call.action === "call" || call.action === "read-resource") {
    return;
  }
  if (host.owner) {
    await host.owner.runCallback("beforeExecute", () => hook(call.id, call.ctx));
  } else {
    await hook(call.id, call.ctx);
  }
}

export async function executeGateway(
  pi: ExtensionAPI,
  host: McpAdapterHost,
  options: McpAdapterOptions,
  [toolCallId, rawParams, signal, , ctx]: HostToolArguments<GatewayArguments>,
): Promise<GatewayResult> {
  const params = prepareGatewayArguments(rawParams);
  await beforeGateway(host, options.beforeExecute, { id: toolCallId, ctx, action: params.action });
  const ready = await host.getToolState(signal);
  if ("content" in ready) {
    return ready;
  }
  const proxy = await import("./proxy-modes.ts");
  const beforeExecute = options.beforeExecute;
  const beforeDispatch = beforeExecute
    ? (callSignal: AbortSignal | undefined, operation: McpOperationContext) =>
        beforeExecute(toolCallId, { ...ctx, signal: callSignal }, operation)
    : undefined;
  if (
    params.server !== undefined &&
    params.server.length > 0 &&
    ["list", "search", "describe", "instructions"].includes(params.action) &&
    !ready.toolMetadata.has(params.server)
  ) {
    const discovery = await proxy.executeConnect(ready, params.server, signal);
    const failed = Boolean(discovery.details.error);
    if (failed) {
      return discovery;
    }
    host.syncToolSurface();
  }
  return dispatchGateway(params, {
    proxy,
    ready,
    signal,
    toolCallId,
    getPiTools: () => pi.getAllTools(),
    beforeDispatch,
    sync: () => host.syncToolSurface(),
  });
}
