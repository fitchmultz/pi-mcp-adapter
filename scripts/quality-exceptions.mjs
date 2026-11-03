import { existsSync, readFileSync } from "node:fs";
import { Visitor } from "oxc-parser";
import { z } from "zod";

const scopeSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ExportNamedDeclaration"), name: z.string().min(1) }),
  z.strictObject({ type: z.literal("FunctionDeclaration"), name: z.string().min(1) }),
  z.strictObject({ type: z.literal("FunctionExpression"), name: z.string().min(1) }),
  z.strictObject({
    type: z.literal("MethodDefinition"),
    class: z.string().min(1),
    name: z.string().min(1),
  }),
  z.strictObject({ type: z.literal("VariableDeclarator"), name: z.string().min(1) }),
]);
const siteSchema = z.strictObject({
  id: z.string().regex(/^QX-\d+$/u),
  file: z.string().min(1),
  rule: z.string().regex(/^[\w-]+\/[\w-]+$/u),
  scope: scopeSchema,
  path: z.array(z.union([z.string(), z.number().int().nonnegative()])),
  nodeType: z.string().min(1),
  operation: z.string().min(1),
  guards: z.array(z.string()),
});
const nodeSchema = z.object({ type: z.string(), start: z.number(), end: z.number() });

export function loadExceptionSites() {
  const file = "quality-exceptions.json";
  if (!existsSync(file)) {
    return [];
  }
  const sites = z.array(siteSchema).parse(JSON.parse(readFileSync(file, "utf8")));
  if (sites.length === 0) {
    return sites;
  }
  const record = readFileSync("docs/quality-exceptions.md", "utf8");
  const ids = new Set(sites.map((site) => site.id));
  for (const id of ids) {
    if (!record.includes(`## ${id}:`)) {
      throw new Error(`Missing quality exception record: ${id}`);
    }
  }
  return sites;
}

/**
 * @param {import("oxc-parser").Program} program
 * @param {z.infer<typeof scopeSchema>} selector
 * @returns {import("oxc-parser").Node}
 */
function selectScope(program, selector) {
  /** @type {import("oxc-parser").Node[]} */
  const matches = [];
  new Visitor({
    ExportNamedDeclaration(node) {
      if (
        selector.type === node.type &&
        node.declaration?.type === "FunctionDeclaration" &&
        node.declaration.id?.name === selector.name
      ) {
        matches.push(node);
      }
    },
    FunctionDeclaration(node) {
      if (selector.type === node.type && node.id?.name === selector.name) {
        matches.push(node);
      }
    },
    FunctionExpression(node) {
      if (selector.type === node.type && node.id?.name === selector.name) {
        matches.push(node);
      }
    },
    ClassDeclaration(node) {
      if (selector.type !== "MethodDefinition" || node.id?.name !== selector.class) {
        return;
      }
      for (const member of node.body.body) {
        if (
          member.type === "MethodDefinition" &&
          member.key.type === "Identifier" &&
          member.key.name === selector.name
        ) {
          matches.push(member);
        }
      }
    },
    VariableDeclarator(node) {
      if (
        selector.type === node.type &&
        node.id.type === "Identifier" &&
        node.id.name === selector.name
      ) {
        matches.push(node);
      }
    },
  }).visit(program);
  const scope = matches[0];
  if (matches.length !== 1 || scope === undefined) {
    throw new Error(`Exception scope is missing or ambiguous: ${JSON.stringify(selector)}`);
  }
  return scope;
}

/** @param {unknown} value @param {string | number} key @returns {unknown} */
function property(value, key) {
  if (typeof value !== "object" || value === null) {
    return;
  }
  const entries = Object.entries(value);
  return entries.find(([name]) => name === String(key))?.[1];
}

/**
 * @param {z.infer<typeof siteSchema>} site
 * @param {import("oxc-parser").Program} program
 * @param {string} source
 */
export function resolveExceptionSite(site, program, source) {
  /** @type {unknown} */
  let selected = selectScope(program, site.scope);
  const guards = [];
  for (const key of site.path) {
    if (property(selected, "type") === "IfStatement") {
      const test = nodeSchema.parse(property(selected, "test"));
      guards.push(`${String(key)}: ${source.slice(test.start, test.end)}`);
    }
    selected = property(selected, key);
  }
  const node = nodeSchema.parse(selected);
  if (
    node.type !== site.nodeType ||
    source.slice(node.start, node.end) !== site.operation ||
    JSON.stringify(guards) !== JSON.stringify(site.guards)
  ) {
    throw new Error(`Authorized operation changed for ${site.id} ${site.file} ${site.rule}`);
  }
  return { ...site, start: node.start };
}
