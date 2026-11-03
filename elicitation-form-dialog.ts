import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ElicitRequestFormParams } from "@modelcontextprotocol/client";
import {
  coerceAndValidateFormValues,
  humanizeName,
  extractMultiSelectOptions,
  formatChoice,
  uniqueLabels,
  uniqueAction,
  type ElicitationValue,
  type FormProperty,
} from "./elicitation-form-values.ts";

export type ElicitationUIContext = Pick<ExtensionUIContext, "select" | "input" | "notify">;
type FieldInput = { name: string; schema: FormProperty; current?: ElicitationValue };
type FieldResult = { cancelled: true } | { cancelled: false; value: ElicitationValue };

export async function collectValidField(
  ui: ElicitationUIContext,
  params: ElicitRequestFormParams,
  field: FieldInput,
): Promise<FieldResult> {
  const { name, schema } = field;
  let current = field.current;
  const required = params.requestedSchema.required?.includes(name) === true;
  while (true) {
    const result = await collectField(ui, params, { name, schema, current });
    if (!("value" in result)) {
      return result;
    }
    try {
      coerceAndValidateFormValues(
        {
          ...params,
          requestedSchema: {
            type: "object",
            properties: { [name]: schema },
            ...(required ? { required: [name] } : {}),
          },
        },
        { [name]: result.value },
      );
      return result;
    } catch (error) {
      ui.notify(error instanceof Error ? error.message : String(error), "error");
      current = result.value;
    }
  }
}

async function collectEnum(
  ui: ElicitationUIContext,
  title: string,
  schema: Extract<FormProperty, { enum: string[] } | { oneOf: unknown }>,
  required: boolean,
): Promise<FieldResult> {
  const choices =
    "oneOf" in schema
      ? schema.oneOf.map((option) => ({
          value: option.const,
          display: formatChoice(option.const, option.title),
        }))
      : schema.enum.map((value, index) => ({
          value,
          display: formatChoice(
            value,
            "enumNames" in schema ? schema.enumNames?.[index] : undefined,
          ),
        }));
  const displays = uniqueLabels(choices.map((choice) => choice.display));
  const actions = [...displays];
  const useDefault =
    schema.default === undefined ? undefined : uniqueAction("Use default", actions);
  if (useDefault !== undefined) {
    actions.push(useDefault);
  }
  const omit = required ? undefined : uniqueAction("Omit", actions);
  if (omit !== undefined) {
    actions.push(omit);
  }
  const action = await ui.select(title, actions);
  if (action === undefined) {
    return { cancelled: true };
  }
  if (action === useDefault) {
    return { cancelled: false, value: schema.default };
  }
  if (action === omit) {
    return { cancelled: false, value: undefined };
  }
  return { cancelled: false, value: choices[displays.indexOf(action)]?.value };
}

async function collectMulti(
  ui: ElicitationUIContext,
  title: string,
  schema: Extract<FormProperty, { type: "array" }>,
  current?: ElicitationValue,
): Promise<FieldResult> {
  const choices = extractMultiSelectOptions(schema);
  const selected = new Set(Array.isArray(current) ? current : []);
  while (true) {
    const displays = uniqueLabels(
      choices.map((choice) =>
        selected.has(choice.value) ? `✓ ${choice.display}` : choice.display,
      ),
    );
    const done = uniqueAction("Done", displays);
    const picked = await ui.select(title, [...displays, done]);
    if (picked === undefined) {
      return { cancelled: true };
    }
    if (picked === done) {
      return { cancelled: false, value: [...selected] };
    }
    const choice = choices[displays.indexOf(picked)];
    if (!choice) {
      continue;
    }
    if (selected.has(choice.value)) {
      selected.delete(choice.value);
    } else {
      selected.add(choice.value);
    }
  }
}

function fieldActions(schema: FormProperty, first: string[], required: boolean): string[] {
  const actions = [...first];
  if (schema.default !== undefined) {
    actions.push("Use default");
  }
  if (!required) {
    actions.push("Omit");
  }
  return actions;
}

async function collectField(
  ui: ElicitationUIContext,
  params: ElicitRequestFormParams,
  field: FieldInput,
): Promise<FieldResult> {
  const { name, schema, current } = field;
  const required = params.requestedSchema.required?.includes(name) === true;
  const title = fieldTitle(name, schema, required);
  if (schema.type === "string" && ("enum" in schema || "oneOf" in schema)) {
    return collectEnum(ui, title, schema, required);
  }
  const actions = fieldActions(schema, primaryActions(schema), required);
  const action = await ui.select(title, actions);
  if (action === undefined) {
    return { cancelled: true };
  }
  if (action === "Use default") {
    return { cancelled: false, value: schema.default };
  }
  if (action === "Omit") {
    return { cancelled: false, value: undefined };
  }
  if (schema.type === "boolean") {
    return { cancelled: false, value: action === "Yes" };
  }
  if (schema.type === "array") {
    return collectMulti(ui, title, schema, current);
  }
  return collectText(ui, title, current);
}

async function collectText(
  ui: ElicitationUIContext,
  title: string,
  current?: ElicitationValue,
): Promise<FieldResult> {
  const entered = await ui.input(title, current === undefined ? undefined : String(current));
  return entered === undefined ? { cancelled: true } : { cancelled: false, value: entered };
}

function fieldTitle(name: string, schema: FormProperty, required: boolean): string {
  return [schema.title ?? humanizeName(name), required ? "(required)" : "", schema.description]
    .filter(Boolean)
    .join(" ");
}

function primaryActions(schema: FormProperty): string[] {
  switch (schema.type) {
    case "boolean":
      return ["Yes", "No"];
    case "array":
      return ["Choose values"];
    case "string":
    case "integer":
    case "number":
      return ["Enter value"];
  }
}
