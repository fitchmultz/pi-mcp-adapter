import { describe, expect, it } from "vitest";
import { createTestExtensionContext } from "./test-extension-context.ts";
import { createMcpRuntimeOwner } from "../runtime-owner.ts";
import { initializeMcp } from "../init.ts";
import {
  MachineHttpServer,
  readMachineBody,
  machineMessageSchema,
  machineJson,
  machineResult,
} from "./fixtures/oauth-machine-wire.ts";

describe("initializeMcp vs. a ctx invalidated mid-connect", () => {
  it.each([
    [
      "does not reject once the session is disposed mid-connect — it should abandon quietly",
      undefined,
    ],
    ["does not read guarded ctx getters again after startup connects", "unexpected ui failure"],
  ])("%s", async (_name, message) => {
    const host = await createTestExtensionContext();
    host.runner.setUIContext(host.context.ui, "tui");
    const owner = createMcpRuntimeOwner();
    const connected = Promise.withResolvers<boolean>();
    const release = Promise.withResolvers<boolean>();
    const server = new MachineHttpServer(async (request, response) => {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      const body = machineMessageSchema.parse(JSON.parse(await readMachineBody(request)));
      if (!("id" in body)) {
        response.writeHead(202).end();
        return;
      }
      if (body.method === "tools/list") {
        connected.resolve(true);
        await release.promise;
      }
      machineJson(response, {
        jsonrpc: "2.0",
        id: body.id,
        result: machineResult(body.method, "startup-race", "ok"),
      });
    });
    try {
      const url = await server.listen();
      const pending = initializeMcp(host.api, host.context, owner, {
        config: { mcpServers: { demo: { url, lifecycle: "eager" } } },
      });
      try {
        await Promise.race([
          connected.promise,
          pending.then(() => {
            throw new Error("Initialization settled before the pending discovery boundary");
          }),
        ]);
        host.runner.invalidate(message);
        release.resolve(true);
        const state = await pending;
        expect(state.manager.getConnection("demo")?.status).toBe("connected");
      } finally {
        release.resolve(true);
        await pending;
      }
    } finally {
      await owner.stop();
      await server.close();
      await host.dispose();
    }
  });
});
