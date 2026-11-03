import type { ElicitRequestFormParams, JsonSchemaType } from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";

import { validationProperty, type FormProperty } from "./elicitation-form-schema.ts";

export type ElicitationValue = string | number | boolean | string[] | undefined;
export type { FormProperty } from "./elicitation-form-schema.ts";
type ProvidedValue = Exclude<ElicitationValue, undefined>;

function stringValue(
  name: string,
  schema: Extract<FormProperty, { type: "string" }>,
  value: ProvidedValue,
): string {
  const result = String(value);
  if ("minLength" in schema && schema.minLength !== undefined && result.length < schema.minLength) {
    throw new Error(`Elicitation field ${name} is shorter than minimum length ${schema.minLength}`);
  }
  if ("maxLength" in schema && schema.maxLength !== undefined && result.length > schema.maxLength) {
    throw new Error(`Elicitation field ${name} is longer than maximum length ${schema.maxLength}`);
  }
  validateStringChoices(name, schema, result);
  return result;
}

function validateStringChoices(
  name: string,
  schema: Extract<FormProperty, { type: "string" }>,
  result: string,
): void {
  if ("enum" in schema && !schema.enum.includes(result)) {
    throw new Error(`Elicitation field ${name} is not an allowed value`);
  }
  if ("oneOf" in schema && !schema.oneOf.some((option) => option.const === result)) {
    throw new Error(`Elicitation field ${name} is not an allowed value`);
  }
}

function numberValue(
  name: string,
  schema: Extract<FormProperty, { type: "number" | "integer" }>,
  value: ProvidedValue,
): number {
  if (typeof value === "string" && value.trim() === "") {
    throw new Error(`Elicitation field ${name} must be a number`);
  }
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(result)) {
    throw new Error(`Elicitation field ${name} must be a number`);
  }
  if (schema.type === "integer" && !Number.isInteger(result)) {
    throw new Error(`Elicitation field ${name} must be an integer`);
  }
  validateNumberRange(name, schema, result);
  return result;
}

function validateNumberRange(
  name: string,
  schema: Extract<FormProperty, { type: "number" | "integer" }>,
  result: number,
): void {
  if (schema.minimum !== undefined && result < schema.minimum) {
    throw new Error(`Elicitation field ${name} is below minimum ${schema.minimum}`);
  }
  if (schema.maximum !== undefined && result > schema.maximum) {
    throw new Error(`Elicitation field ${name} is above maximum ${schema.maximum}`);
  }
}

function arrayValue(
  name: string,
  schema: Extract<FormProperty, { type: "array" }>,
  value: ProvidedValue,
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Elicitation field ${name} must be a list`);
  }
  const allowed = new Set(extractMultiSelectOptions(schema).map((option) => option.value));
  const result = value.map(String);
  if (schema.minItems !== undefined && result.length < schema.minItems) {
    throw new Error(`Elicitation field ${name} has fewer than ${schema.minItems} selections`);
  }
  if (schema.maxItems !== undefined && result.length > schema.maxItems) {
    throw new Error(`Elicitation field ${name} has more than ${schema.maxItems} selections`);
  }
  if (result.some((item) => !allowed.has(item))) {
    throw new Error(`Elicitation field ${name} contains an invalid selection`);
  }
  return result;
}

function coerceValue(name: string, schema: FormProperty, value: ProvidedValue): ProvidedValue {
  switch (schema.type) {
    case "string":
      return stringValue(name, schema, value);
    case "number":
    case "integer":
      return numberValue(name, schema, value);
    case "boolean":
      return typeof value === "boolean" ? value : value === "true";
    case "array":
      return arrayValue(name, schema, value);
  }
}

export function coerceAndValidateFormValues(
  params: ElicitRequestFormParams,
  values: Record<string, ElicitationValue>,
): Record<string, ProvidedValue> {
  const output: Record<string, ProvidedValue> = {};
  const required = new Set(params.requestedSchema.required ?? []);
  for (const [name, schema] of Object.entries(params.requestedSchema.properties)) {
    const value = values[name];
    if (value === undefined) {
      if (required.has(name)) {
        throw new Error(`Missing required elicitation field: ${name}`);
      }
      continue;
    }
    output[name] = coerceValue(name, schema, value);
  }
  const { required: requiredFields, ...requestedSchema } = params.requestedSchema;
  const schema: JsonSchemaType = {
    ...requestedSchema,
    properties: Object.fromEntries(
      Object.entries(params.requestedSchema.properties).map(([name, property]) => [
        name,
        validationProperty(property),
      ]),
    ),
    ...(requiredFields !== undefined ? { required: requiredFields } : {}),
  };
  const validation = new AjvJsonSchemaValidator().getValidator(schema)(output);
  if (!validation.valid) {
    throw new Error(`Invalid elicitation response: ${validation.errorMessage}`);
  }
  return output;
}

export function humanizeName(name: string): string {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (char) => char.toUpperCase());
}

export function formatChoice(value: string, title?: string): string {
  return title !== undefined && title !== "" && title !== value ? `${title} (${value})` : value;
}

export function uniqueLabels(labels: string[]): string[] {
  const used = new Set<string>();
  return labels.map((label) => {
    let unique = label;
    while (used.has(unique)) {
      unique += "…";
    }
    used.add(unique);
    return unique;
  });
}

export function uniqueAction(label: string, choices: string[]): string {
  let unique = label;
  while (choices.includes(unique)) {
    unique += "…";
  }
  return unique;
}

export function extractMultiSelectOptions(
  schema: Extract<FormProperty, { type: "array" }>,
): Array<{ value: string; display: string }> {
  const items = schema.items;
  return "anyOf" in items
    ? items.anyOf.map((option) => ({
        value: option.const,
        display: formatChoice(option.const, option.title),
      }))
    : items.enum.map((value) => ({ value, display: value }));
}
