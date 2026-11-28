import type { TuiMouseEvent } from "@earendil-works/pi-tui";

export function noop(): void {
  // Rendering and completion callbacks have no side effects in these tests.
}

export function mouseEvent(
  input: Pick<TuiMouseEvent, "type"> & Partial<TuiMouseEvent>,
): TuiMouseEvent {
  return {
    button: "none",
    x: 5,
    y: 0,
    screenX: 5,
    screenY: input.y ?? 0,
    width: 82,
    height: 30,
    shift: false,
    alt: false,
    ctrl: false,
    ...input,
  };
}
