import type { UiResourceCsp, UiResourceMeta } from "./types.ts";
import { isUiJsonObject } from "./ui-json.ts";

const OPENAI_CSP_FIELD_MAPPINGS = [
  ["resource_domains", "resourceDomains"],
  ["connect_domains", "connectDomains"],
  ["frame_domains", "frameDomains"],
] as const;
const UI_CSP_DOMAIN_FIELDS: readonly (keyof UiResourceCsp)[] = [
  "resourceDomains",
  "connectDomains",
  "frameDomains",
  "baseUriDomains",
];

export function extractUiMeta(meta: Record<string, unknown> | undefined): UiResourceMeta {
  if (!meta) {
    return {};
  }
  const ui = isUiJsonObject(meta.ui) ? meta.ui : undefined;
  const csp = extractCsp(meta, ui);
  return {
    ...(csp !== undefined ? { csp } : {}),
    ...(ui && isUiJsonObject(ui.permissions) ? { permissions: ui.permissions } : {}),
    ...(ui && typeof ui.domain === "string" ? { domain: ui.domain } : {}),
    ...(ui && typeof ui.prefersBorder === "boolean" ? { prefersBorder: ui.prefersBorder } : {}),
  };
}

function extractCsp(
  meta: Record<string, unknown>,
  ui: Record<string, unknown> | undefined,
): UiResourceCsp | undefined {
  const openAiCsp = hasOwnProperty(meta, "openai/widgetCSP")
    ? normalizeOpenAiWidgetCsp(meta["openai/widgetCSP"])
    : undefined;
  const hasStandardCsp = ui !== undefined && hasOwnProperty(ui, "csp");
  const standardCspValue = hasStandardCsp ? ui.csp : undefined;
  if (hasStandardCsp && !isUiJsonObject(standardCspValue)) {
    // A declared canonical container takes precedence even when malformed.
    return {};
  }
  const standardCsp = hasStandardCsp ? normalizeUiResourceCsp(standardCspValue) : undefined;
  if (!openAiCsp && !standardCsp) {
    return undefined;
  }
  return mergeCanonicalCsp(openAiCsp, standardCsp, standardCspValue);
}

function mergeCanonicalCsp(
  openAiCsp: UiResourceCsp | undefined,
  standardCsp: UiResourceCsp | undefined,
  standardCspValue: unknown,
): UiResourceCsp {
  const csp = { ...openAiCsp, ...standardCsp };
  if (!isUiJsonObject(standardCspValue)) {
    return csp;
  }
  for (const [, field] of OPENAI_CSP_FIELD_MAPPINGS) {
    if (hasOwnProperty(standardCspValue, field) && !copyStringArray(standardCspValue[field])) {
      delete csp[field];
    }
  }
  return csp;
}

function normalizeUiResourceCsp(value: unknown): UiResourceCsp {
  if (!isUiJsonObject(value)) {
    return {};
  }
  const csp: UiResourceCsp = {};
  for (const field of UI_CSP_DOMAIN_FIELDS) {
    const domains = copyStringArray(value[field]);
    if (domains) {
      csp[field] = domains;
    }
  }
  return csp;
}

function normalizeOpenAiWidgetCsp(value: unknown): UiResourceCsp {
  if (!isUiJsonObject(value)) {
    return {};
  }
  const csp: UiResourceCsp = {};
  for (const [sourceField, targetField] of OPENAI_CSP_FIELD_MAPPINGS) {
    const domains = copyStringArray(value[sourceField]);
    if (domains) {
      csp[targetField] = domains;
    }
  }
  return csp;
}

function copyStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries: unknown[] = value;
  return entries.every((entry): entry is string => typeof entry === "string")
    ? [...entries]
    : undefined;
}

function hasOwnProperty(record: Record<string, unknown>, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, property);
}
