import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { UI_STREAM_HOST_CONTEXT_KEY } from "./ui-stream-types.ts";
import { readHostConfiguration, readHostContext } from "./host-browser-contracts.ts";
import { HostBrowserView } from "./host-browser-view.ts";
import { HostBrowserProxy } from "./host-browser-proxy.ts";
import { HostBrowserActions } from "./host-browser-actions.ts";
import { HostBrowserSession } from "./host-browser-session.ts";

const config = readHostConfiguration();
const view = new HostBrowserView(config);
const hostContext = readHostContext(config.hostContext);
const initialStreamContext = hostContext[UI_STREAM_HOST_CONTEXT_KEY];
const streamMode =
  typeof initialStreamContext === "object" &&
  initialStreamContext !== null &&
  "mode" in initialStreamContext &&
  initialStreamContext.mode === "stream-first"
    ? "stream-first"
    : "eager";
const bridge = new AppBridge(
  null,
  { name: "pi", version: "1.0.0" },
  { serverTools: {}, openLinks: {}, logging: {}, updateModelContext: {}, message: {} },
  { hostContext },
);
const proxy = new HostBrowserProxy(config.sessionToken);
const actions = new HostBrowserActions(bridge, proxy, view, config);
actions.listen();
bridge.addEventListener("initialized", () => {
  if (streamMode !== "stream-first") {
    bridge.sendToolInput({ arguments: config.toolArgs }).catch((error: unknown) => {
      view.showError("Failed to forward tool input: " + String(error));
    });
  }
  view.setStatus(streamMode === "stream-first" ? "Streaming…" : "Connected");
});
bridge.addEventListener("sizechange", (size) => view.resize(size));

// Connect before loading the app so its native initialize request cannot race us.
try {
  if (!view.iframe.contentWindow) {
    throw new Error("App iframe has no window");
  }
  await bridge.connect(
    new PostMessageTransport(view.iframe.contentWindow, view.iframe.contentWindow),
  );
} catch (error) {
  console.error("[host] Bridge connection failed:", error);
  view.showError("Failed to initialize AppBridge: " + String(error));
}
await view.load(config.uiResourceToken);
const session = new HostBrowserSession(bridge, proxy, view, config.sessionToken);
session.listen();
