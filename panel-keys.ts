import { getSelectPageIndex, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";

/** The `tui.select.*` keybinding ids the adapter panels resolve. */
export type PanelSelectKeybinding =
  | "tui.select.up"
  | "tui.select.down"
  | "tui.select.confirm"
  | "tui.select.pageUp"
  | "tui.select.pageDown";

/** Keybindings manager accepted by adapter panels (`@earendil-works/pi-tui` or Pi's subclass). */
export type PanelKeybindings = KeybindingsManager;

/**
 * Key matchers for list navigation: user's `tui.select.*` bindings when a
 * manager is provided, otherwise pi-tui's `TUI_KEYBINDINGS` defaults.
 */
export interface PanelKeys {
  selectUp: (data: string) => boolean;
  selectDown: (data: string) => boolean;
  selectConfirm: (data: string) => boolean;
  selectPage: (
    data: string,
    selectedIndex: number,
    itemCount: number,
    pageSize: number,
  ) => number | undefined;
}

const defaultKeybindings = new KeybindingsManager(TUI_KEYBINDINGS);

export function createPanelKeys(keybindings?: PanelKeybindings): PanelKeys {
  const active = keybindings ?? defaultKeybindings;
  return {
    selectUp: (data) => active.matches(data, "tui.select.up"),
    selectDown: (data) => active.matches(data, "tui.select.down"),
    selectConfirm: (data) => active.matches(data, "tui.select.confirm"),
    selectPage: (data, selectedIndex, itemCount, pageSize) =>
      itemCount === 0
        ? undefined
        : getSelectPageIndex(active, data, selectedIndex, itemCount, pageSize),
  };
}
