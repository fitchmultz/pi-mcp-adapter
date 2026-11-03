import type { ElicitRequestFormParams, JsonSchemaType } from "@modelcontextprotocol/client";
export type FormProperty = ElicitRequestFormParams["requestedSchema"]["properties"][string];

// SDK elicitation schemas allow explicitly undefined optional fields; the validator's
// JSON Schema interface represents absent values by omission.
export function validationProperty(schema: FormProperty): JsonSchemaType {
  const { title, description, default: defaultValue, ...constraints } = schema;
  const entries: Array<[string, unknown]> = Object.entries(schema);
  const extra = Object.fromEntries(entries.filter(([, value]) => value !== undefined));
  const base = {
    ...extra,
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
  };
  switch (constraints.type) {
    case "boolean":
      return { type: "boolean", ...base };
    case "string":
      return { ...stringConstraints(constraints), ...base };
    case "number":
    case "integer":
      return {
        type: constraints.type,
        ...base,
        ...(constraints.minimum !== undefined ? { minimum: constraints.minimum } : {}),
        ...(constraints.maximum !== undefined ? { maximum: constraints.maximum } : {}),
      };
    case "array":
      return {
        type: "array",
        ...base,
        items: constraints.items,
        ...(constraints.minItems !== undefined ? { minItems: constraints.minItems } : {}),
        ...(constraints.maxItems !== undefined ? { maxItems: constraints.maxItems } : {}),
      };
  }
}

function stringConstraints(schema: Extract<FormProperty, { type: "string" }>): JsonSchemaType {
  if ("oneOf" in schema) {
    return { type: "string", oneOf: schema.oneOf };
  }
  if ("enum" in schema) {
    return {
      type: "string",
      enum: schema.enum,
      ...("enumNames" in schema && schema.enumNames !== undefined
        ? { enumNames: schema.enumNames }
        : {}),
    };
  }
  return {
    type: "string",
    ...(schema.minLength !== undefined ? { minLength: schema.minLength } : {}),
    ...(schema.maxLength !== undefined ? { maxLength: schema.maxLength } : {}),
    ...(schema.format !== undefined ? { format: schema.format } : {}),
  };
}
