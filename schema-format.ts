import { asObjectRecord } from "./mcp-output-values.ts";

/** Guard against deeply nested recursive schema expansions. */
const MAX_SCHEMA_DEPTH = 6;

interface FormatContext {
  readonly root: Record<string, unknown>;
  readonly seen: ReadonlySet<object>;
  readonly depth: number;
}

function unescapePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveLocalPointer(
  ref: string,
  root: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (ref === "#") {
    return root;
  }
  if (!ref.startsWith("#/")) {
    return undefined;
  }
  let current: unknown = root;
  for (const rawSegment of ref.slice(2).split("/")) {
    const record = asObjectRecord(current);
    if (!record || Array.isArray(current)) {
      return undefined;
    }
    const key = unescapePointerSegment(rawSegment);
    if (!Object.hasOwn(record, key)) {
      return undefined;
    }
    current = record[key];
  }
  const target = asObjectRecord(current);
  return target && !Array.isArray(current) ? target : undefined;
}

function resolveSchemaRef(
  schema: Record<string, unknown>,
  ctx: FormatContext,
): { readonly resolved: Record<string, unknown>; readonly seen: ReadonlySet<object> } {
  const ref = schema.$ref;
  if (typeof ref !== "string") {
    return { resolved: schema, seen: ctx.seen };
  }
  const target = resolveLocalPointer(ref, ctx.root);
  if (!target) {
    return { resolved: schema, seen: ctx.seen };
  }
  if (ctx.seen.has(target)) {
    return { resolved: { ...schema, $circularRef: ref }, seen: ctx.seen };
  }
  const nextSeen = new Set(ctx.seen);
  nextSeen.add(target);
  const { $ref: _ignored, ...siblings } = schema;
  const merged = Object.keys(siblings).length > 0 ? { ...target, ...siblings } : target;
  return resolveSchemaRef(merged, { ...ctx, seen: nextSeen });
}

function mergeAdditionalProperties(current: unknown, incoming: unknown): unknown {
  if (current === false || incoming === false) {
    return false;
  }
  return incoming !== undefined ? incoming : current;
}

interface BranchAccumulator {
  readonly base: Record<string, unknown>;
  readonly properties: Record<string, unknown>;
  readonly required: Set<string>;
  readonly hasProperties: boolean;
}

function mergeBaseKeywords(
  current: Record<string, unknown>,
  branch: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(branch)) {
    if (key === "properties" || key === "required" || key === "allOf") {
      continue;
    }
    if (key === "additionalProperties") {
      next.additionalProperties = mergeAdditionalProperties(next.additionalProperties, value);
    } else if (next[key] === undefined) {
      next[key] = value;
    }
  }
  return next;
}

function mergeBranch(
  accumulator: BranchAccumulator,
  branch: Record<string, unknown>,
): BranchAccumulator {
  const branchProps = asObjectRecord(branch.properties);
  const hasNewProps = branchProps !== undefined && !Array.isArray(branch.properties);
  const properties = hasNewProps
    ? { ...accumulator.properties, ...branchProps }
    : accumulator.properties;
  const required = new Set(accumulator.required);
  if (Array.isArray(branch.required)) {
    for (const req of branch.required) {
      if (typeof req === "string") {
        required.add(req);
      }
    }
  }
  return {
    base: mergeBaseKeywords(accumulator.base, branch),
    properties,
    required,
    hasProperties: accumulator.hasProperties || hasNewProps,
  };
}

function flattenSchema(
  raw: Record<string, unknown>,
  ctx: FormatContext,
): { readonly schema: Record<string, unknown>; readonly ctx: FormatContext } {
  const { resolved, seen } = resolveSchemaRef(raw, ctx);
  const nextCtx: FormatContext = { ...ctx, seen };
  if (!Array.isArray(resolved.allOf) || resolved.allOf.length === 0) {
    return { schema: resolved, ctx: nextCtx };
  }
  const { allOf, ...rest } = resolved;
  let accumulator = mergeBranch(
    { base: { ...rest }, properties: {}, required: new Set<string>(), hasProperties: false },
    rest,
  );
  for (const entry of allOf) {
    const branchRecord = asObjectRecord(entry);
    if (!branchRecord || Array.isArray(entry)) {
      continue;
    }
    accumulator = mergeBranch(accumulator, flattenSchema(branchRecord, nextCtx).schema);
  }
  const merged: Record<string, unknown> = { ...accumulator.base };
  if (accumulator.hasProperties) {
    merged.properties = accumulator.properties;
    if (merged.type === undefined) {
      merged.type = "object";
    }
  }
  if (accumulator.required.size > 0) {
    merged.required = [...accumulator.required];
  }
  return { schema: merged, ctx: nextCtx };
}

function requiredSet(schema: Record<string, unknown>): Set<string> {
  return new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === "string")
      : [],
  );
}

interface PropertyField {
  readonly name: string;
  readonly schema: unknown;
  readonly required: boolean;
}

function formatAdditionalProperties(value: unknown, indent: string, ctx: FormatContext): string[] {
  if (value === undefined) {
    return [];
  }
  if (typeof value === "boolean") {
    return [`${indent}(additionalProperties: ${String(value)})`];
  }
  return formatProperty(
    { name: "additionalProperties", schema: value, required: false },
    indent,
    ctx,
  );
}

function formatObjectBody(
  schema: Record<string, unknown>,
  indent: string,
  ctx: FormatContext,
): string[] {
  const lines: string[] = [];
  const props = asObjectRecord(schema.properties);
  const required = requiredSet(schema);
  if (props && !Array.isArray(schema.properties)) {
    for (const [name, propSchema] of Object.entries(props)) {
      lines.push(
        ...formatProperty({ name, schema: propSchema, required: required.has(name) }, indent, ctx),
      );
    }
  }
  if (Array.isArray(schema.anyOf)) {
    lines.push(...formatVariants("anyOf", schema.anyOf, indent, ctx));
  }
  if (Array.isArray(schema.oneOf)) {
    lines.push(...formatVariants("oneOf", schema.oneOf, indent, ctx));
  }
  lines.push(...formatAdditionalProperties(schema.additionalProperties, indent, ctx));
  return lines;
}

export function formatSchema(schema: unknown, indent = "  "): string {
  const root = asObjectRecord(schema);
  if (!root || Array.isArray(schema)) {
    return `${indent}(no schema)`;
  }

  const initial: FormatContext = { root, seen: new Set([root]), depth: 0 };
  const { schema: effective, ctx } = flattenSchema(root, initial);
  const props = asObjectRecord(effective.properties);
  const hasPropsObject = props !== undefined && !Array.isArray(effective.properties);
  const hasObjectShape = effective.type === "object" || hasPropsObject;

  if (hasObjectShape) {
    const lines = formatObjectBody(effective, indent, ctx);
    return lines.length > 0 ? lines.join("\n") : `${indent}(no parameters)`;
  }

  const lines = formatNestedSchema(effective, indent, ctx);
  if (lines.length > 0) {
    return lines.join("\n");
  }

  const typeStr = formatType(effective);
  return typeStr !== "" ? `${indent}(${typeStr})` : `${indent}(complex schema)`;
}

function formatProperty(field: PropertyField, indent: string, ctx: FormatContext): string[] {
  const record = asObjectRecord(field.schema);
  if (!record || Array.isArray(field.schema)) {
    return [`${indent}${field.name}${field.required ? " *required*" : ""}`];
  }

  const { schema: effective, ctx: resolvedCtx } = flattenSchema(record, ctx);
  const parts = [`${indent}${field.name}`];
  const typeStr = formatType(effective);
  if (typeStr !== "") {
    parts.push(`(${typeStr})`);
  }
  if (field.required) {
    parts.push("*required*");
  }
  appendSchemaAnnotations(parts, effective);

  const childCtx: FormatContext = { ...resolvedCtx, depth: ctx.depth + 1 };
  const nested =
    childCtx.depth <= MAX_SCHEMA_DEPTH
      ? formatNestedSchema(effective, `${indent}  `, childCtx)
      : [];
  return [parts.join(" "), ...nested];
}

function formatNestedSchema(
  schema: Record<string, unknown>,
  indent: string,
  ctx: FormatContext,
): string[] {
  const lines: string[] = [];

  if (Array.isArray(schema.anyOf)) {
    lines.push(...formatVariants("anyOf", schema.anyOf, indent, ctx));
  }
  if (Array.isArray(schema.oneOf)) {
    lines.push(...formatVariants("oneOf", schema.oneOf, indent, ctx));
  }
  if (schema.items !== undefined) {
    lines.push(
      ...formatProperty({ name: "items", schema: schema.items, required: false }, indent, ctx),
    );
  }
  const properties = asObjectRecord(schema.properties);
  if (properties && !Array.isArray(schema.properties)) {
    const required = requiredSet(schema);
    for (const [name, propSchema] of Object.entries(properties)) {
      lines.push(
        ...formatProperty({ name, schema: propSchema, required: required.has(name) }, indent, ctx),
      );
    }
  }
  lines.push(...formatAdditionalProperties(schema.additionalProperties, indent, ctx));

  return lines;
}

function formatVariants(
  keyword: "anyOf" | "oneOf",
  variants: unknown[],
  indent: string,
  ctx: FormatContext,
): string[] {
  const lines = [`${indent}${keyword}:`];
  const childCtx: FormatContext = { ...ctx, depth: ctx.depth + 1 };

  for (const variant of variants) {
    const record = asObjectRecord(variant);
    if (!record || Array.isArray(variant)) {
      lines.push(`${indent}  - ${JSON.stringify(variant)}`);
      continue;
    }

    const { schema: effective, ctx: resolvedCtx } = flattenSchema(record, childCtx);
    const formatted = formatType(effective);
    const typeStr = formatted === "" ? "schema" : formatted;
    const parts = [`${indent}  - ${typeStr}`];
    appendSchemaAnnotations(parts, effective);
    lines.push(parts.join(" "));
    if (childCtx.depth <= MAX_SCHEMA_DEPTH) {
      lines.push(...formatNestedSchema(effective, `${indent}    `, resolvedCtx));
    }
  }

  return lines;
}

function formatRefOrValueType(schema: Record<string, unknown>): string | undefined {
  if (typeof schema.$circularRef === "string") {
    return `circular $ref: ${schema.$circularRef}`;
  }
  if (typeof schema.$ref === "string") {
    return `$ref: ${schema.$ref}`;
  }
  if (Object.hasOwn(schema, "const")) {
    return `const ${JSON.stringify(schema.const)}`;
  }
  if (Array.isArray(schema.enum)) {
    return `enum: ${schema.enum.map((value) => JSON.stringify(value)).join(", ")}`;
  }
  return undefined;
}

function formatType(schema: Record<string, unknown>): string {
  const special = formatRefOrValueType(schema);
  if (special !== undefined) {
    return special;
  }
  if (Array.isArray(schema.type)) {
    return schema.type.map((type) => String(type)).join(" | ");
  }
  const type: unknown = schema.type;
  if (typeof type === "string" && type !== "") {
    return type;
  }
  const properties = asObjectRecord(schema.properties);
  if (properties && !Array.isArray(schema.properties)) {
    return "object";
  }
  return schema.items !== undefined ? "array" : "";
}

function appendSchemaAnnotations(parts: string[], schema: Record<string, unknown>): void {
  if (typeof schema.description === "string" && schema.description !== "") {
    parts.push(`- ${schema.description}`);
  }

  for (const key of [
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "minItems",
    "maxItems",
    "format",
    "pattern",
  ] as const) {
    if (schema[key] !== undefined) {
      parts.push(`[${key}: ${JSON.stringify(schema[key])}]`);
    }
  }

  if (schema.default !== undefined) {
    parts.push(`[default: ${JSON.stringify(schema.default)}]`);
  }
}
