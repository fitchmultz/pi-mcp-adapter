import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function valueOf(input: unknown): unknown {
  return input !== null && typeof input === "object" && "value" in input ? input.value : undefined;
}

export function installPolicy(pi: ExtensionAPI): void {
  pi.on("tool_call", (event) =>
    event.toolName === "local_echo" && valueOf(event.input) === "blocked"
      ? { block: true, reason: "fixture policy" }
      : undefined,
  );
  pi.on("tool_result", (event) =>
    event.toolName === "local_echo" && valueOf(event.structuredContent) === "redact"
      ? { content: [{ type: "text", text: "Redacted" }] }
      : undefined,
  );
}

export function nativeProbe(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "native_probe",
    label: "Native probe",
    description: "Native test composition",
    parameters: Type.Object({}),
    async execute(_id, params, signal, _update, ctx) {
      const outcome = await ctx.executeTool(
        "local_echo",
        params,
        signal === undefined ? {} : { signal },
      );
      return { content: [{ type: "text", text: "Native probe completed" }], details: { outcome } };
    },
  });
  installPolicy(pi);
}
