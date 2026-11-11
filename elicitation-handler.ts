import {
  type Client,
  ProtocolErrorCode,
  ProtocolError,
  type ElicitRequest,
  type ElicitRequestFormParams,
  type ElicitRequestURLParams,
  type ElicitResult,
} from "@modelcontextprotocol/client";
import open from "open";

import {
  coerceAndValidateFormValues,
  humanizeName,
  type ElicitationValue,
  type FormProperty,
} from "./elicitation-form-values.ts";
import {
  bindDialogSignal,
  collectValidField,
  type ElicitationUIContext,
} from "./elicitation-form-dialog.ts";
export { coerceAndValidateFormValues, type ElicitationValue } from "./elicitation-form-values.ts";
export type { ElicitationUIContext } from "./elicitation-form-dialog.ts";

export interface ElicitationHandlerOptions {
  serverName: string;
  ui: ElicitationUIContext;
  allowUrl: boolean;
  /** Dismisses every dialog this handler opens when the owning runtime stops. */
  signal?: AbortSignal;
  onUrlAccepted?: (elicitationId: string) => void;
}

export type ServerElicitationConfig = Omit<
  ElicitationHandlerOptions,
  "serverName" | "onUrlAccepted"
>;

export function registerElicitationHandler(
  client: Client,
  options: ElicitationHandlerOptions,
  own: (run: () => Promise<ElicitResult>) => Promise<ElicitResult> = (run) => run(),
): void {
  client.setRequestHandler("elicitation/create", (request) =>
    own(() => handleElicitationRequest(options, request)),
  );
}

export async function handleElicitationRequest(
  options: ElicitationHandlerOptions,
  request: ElicitRequest,
): Promise<ElicitResult> {
  const ui =
    options.signal === undefined ? options.ui : bindDialogSignal(options.ui, options.signal);
  return request.params.mode === "url"
    ? handleUrlElicitation({ ...options, ui }, request.params)
    : handleFormElicitation({ ...options, ui }, request.params);
}

export async function handleFormElicitation(
  options: ElicitationHandlerOptions,
  params: ElicitRequestFormParams,
): Promise<ElicitResult> {
  const decision = await options.ui.select(
    `MCP Input Request\nServer: ${options.serverName}\n\n${params.message}`,
    ["Continue", "Decline"],
  );
  if (decision === undefined) {
    return { action: "cancel" };
  }
  if (decision === "Decline") {
    return { action: "decline" };
  }

  const values: Record<string, ElicitationValue> = {};
  const properties = Object.entries(params.requestedSchema.properties);
  for (const [name, schema] of properties) {
    const value = await collectValidField(options.ui, params, { name, schema });
    if (!("value" in value)) {
      return { action: "cancel" };
    }
    values[name] = value.value;
  }

  while (true) {
    const content = coerceAndValidateFormValues(params, values);
    const action = await options.ui.select(
      formatReview(options.serverName, properties, content),
      properties.length > 0 ? ["Submit", "Edit", "Decline"] : ["Submit", "Decline"],
    );
    const result = reviewResult(action, content);
    if (result) {
      return result;
    }

    const edit = await editFormField(options.ui, params, { properties, values });
    if (edit.kind === "cancel") {
      return { action: "cancel" };
    }
    if (edit.kind === "edit") {
      values[edit.name] = edit.value;
    }
  }
}

function reviewResult(
  action: string | undefined,
  content: Record<string, string | number | boolean | string[]>,
): ElicitResult | undefined {
  if (action === undefined) {
    return { action: "cancel" };
  }
  if (action === "Decline") {
    return { action: "decline" };
  }
  return action === "Submit" ? { action: "accept", content } : undefined;
}

async function editFormField(
  ui: ElicitationUIContext,
  params: ElicitRequestFormParams,
  form: { properties: Array<[string, FormProperty]>; values: Record<string, ElicitationValue> },
): Promise<
  | { kind: "cancel" }
  | { kind: "unchanged" }
  | { kind: "edit"; name: string; value: ElicitationValue }
> {
  const { properties, values } = form;
  const labels = properties.map(
    ([name, schema]) => `${schema.title ?? humanizeName(name)} (${name})`,
  );
  const selected = await ui.select("Choose a field to edit", labels);
  if (selected === undefined) {
    return { kind: "cancel" };
  }
  const property = properties[labels.indexOf(selected)];
  if (!property) {
    return { kind: "unchanged" };
  }
  const [name, schema] = property;
  const value = await collectValidField(ui, params, { name, schema, current: values[name] });
  if (!("value" in value)) {
    return { kind: "cancel" };
  }
  return { kind: "edit", name, value: value.value };
}

function formatReview(
  serverName: string,
  properties: Array<[string, FormProperty]>,
  content: Record<string, string | number | boolean | string[]>,
): string {
  const rows = properties.map(
    ([name, schema]) =>
      `${schema.title ?? humanizeName(name)}: ${content[name] === undefined ? "(omitted)" : String(content[name])}`,
  );
  return [`Review input for ${serverName}`, "", ...rows].join("\n");
}

export async function handleUrlElicitation(
  options: ElicitationHandlerOptions,
  params: ElicitRequestURLParams,
): Promise<ElicitResult> {
  if (!options.allowUrl) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, "URL elicitation is not supported");
  }

  let parsed: URL;
  try {
    parsed = new URL(params.url);
  } catch {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      "URL elicitation supplied an invalid URL",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      "URL elicitation only supports HTTP and HTTPS URLs",
    );
  }

  const decision = await options.ui.select(
    [
      "MCP Browser Request",
      `Server: ${options.serverName}`,
      "",
      params.message,
      "",
      `Host: ${parsed.host}`,
      `Full URL: ${params.url}`,
      "",
      "Open this URL in your browser?",
    ].join("\n"),
    ["Open", "Decline"],
  );
  if (decision === undefined) {
    return { action: "cancel" };
  }
  if (decision === "Decline") {
    return { action: "decline" };
  }

  try {
    await open(params.url);
  } catch (error) {
    options.ui.notify(
      `Could not open MCP elicitation URL: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return { action: "cancel" };
  }
  options.onUrlAccepted?.(params.elicitationId);
  options.ui.notify("Opened browser for MCP elicitation.", "info");
  return { action: "accept" };
}
