import { isUiJsonObject } from "./ui-json.ts";

export type UiToolVisibility = "model" | "app";

export function extractUiToolVisibility(
  meta: Record<string, unknown> | undefined,
): UiToolVisibility[] | undefined {
  if (!meta) {
    return undefined;
  }
  const ui = meta.ui;
  if (!isUiJsonObject(ui)) {
    return undefined;
  }
  const visibility: unknown = ui.visibility;
  if (visibility === undefined) {
    return undefined;
  }
  if (!Array.isArray(visibility)) {
    return [];
  }

  const values: UiToolVisibility[] = [];
  const entries: unknown[] = visibility;
  for (const entry of entries) {
    if (entry !== "model" && entry !== "app") {
      return [];
    }
    if (!values.includes(entry)) {
      values.push(entry);
    }
  }
  return values;
}

export function isUiToolVisibleToModel(
  visibility: readonly UiToolVisibility[] | undefined,
): boolean {
  return visibility === undefined || visibility.includes("model");
}

export function isUiToolCallableByApp(
  visibility: readonly UiToolVisibility[] | undefined,
): boolean {
  return visibility === undefined || visibility.includes("app");
}
