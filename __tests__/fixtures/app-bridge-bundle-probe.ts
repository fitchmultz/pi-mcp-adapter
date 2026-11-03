import assert from "node:assert/strict";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

function probeBridge(): void {
  assert.equal(typeof PostMessageTransport, "function");
  const bridge = new AppBridge(
    null,
    { name: "pi", version: "1.0.0" },
    {
      serverTools: {},
      openLinks: {},
      logging: {},
      updateModelContext: {},
      message: {},
    },
    { hostContext: {} },
  );
  for (const method of [
    "connect",
    "sendToolInput",
    "sendToolResult",
    "sendToolCancelled",
    "notification",
    "setHostContext",
    "teardownResource",
  ] satisfies Array<keyof AppBridge>) {
    assert.equal(typeof bridge[method], "function", method);
  }

  const oncalltool: NonNullable<AppBridge["oncalltool"]> = async () => ({ content: [] });
  bridge.oncalltool = oncalltool;
  assert.equal(bridge.oncalltool, oncalltool, "oncalltool");
  const onmessage: NonNullable<AppBridge["onmessage"]> = async () => ({});
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- QX-030: ui/message is a request callback, not an event.
  bridge.onmessage = onmessage;
  assert.equal(bridge.onmessage, onmessage, "onmessage");
  const onupdatemodelcontext: NonNullable<AppBridge["onupdatemodelcontext"]> = async () => ({});
  bridge.onupdatemodelcontext = onupdatemodelcontext;
  assert.equal(bridge.onupdatemodelcontext, onupdatemodelcontext, "onupdatemodelcontext");
  const ondownloadfile: NonNullable<AppBridge["ondownloadfile"]> = async () => ({});
  bridge.ondownloadfile = ondownloadfile;
  assert.equal(bridge.ondownloadfile, ondownloadfile, "ondownloadfile");
  const onrequestdisplaymode: NonNullable<AppBridge["onrequestdisplaymode"]> = async ({
    mode,
  }) => ({ mode });
  bridge.onrequestdisplaymode = onrequestdisplaymode;
  assert.equal(bridge.onrequestdisplaymode, onrequestdisplaymode, "onrequestdisplaymode");
  const onopenlink: NonNullable<AppBridge["onopenlink"]> = async () => ({});
  bridge.onopenlink = onopenlink;
  assert.equal(bridge.onopenlink, onopenlink, "onopenlink");
  const oninitialized: NonNullable<AppBridge["oninitialized"]> = () => {
    // Only callback registration is under test.
  };
  // oxlint-disable-next-line typescript/no-deprecated -- QX-030: retain the standalone bundle callback contract.
  bridge.oninitialized = oninitialized;
  // oxlint-disable-next-line typescript/no-deprecated -- QX-030: verify the original callback identity.
  assert.equal(bridge.oninitialized, oninitialized, "oninitialized");
  const onsizechange: NonNullable<AppBridge["onsizechange"]> = () => {
    // Only callback registration is under test.
  };
  // oxlint-disable-next-line typescript/no-deprecated -- QX-030: retain the standalone bundle callback contract.
  bridge.onsizechange = onsizechange;
  // oxlint-disable-next-line typescript/no-deprecated -- QX-030: verify the original callback identity.
  assert.equal(bridge.onsizechange, onsizechange, "onsizechange");
}

probeBridge();
