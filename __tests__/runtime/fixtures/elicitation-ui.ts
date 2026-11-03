import { vi, type Mock } from "vitest";
import type { ElicitationUIContext } from "../../../elicitation-handler.ts";

/** Script only the dialogs consumed by elicitation; retain their native signatures and history. */
export function createElicitationUi(
  answers: readonly (string | undefined)[] = [],
  inputs: readonly (string | undefined)[] = [],
): {
  select: Mock<ElicitationUIContext["select"]>;
  input: Mock<ElicitationUIContext["input"]>;
  notify: Mock<ElicitationUIContext["notify"]>;
} {
  const selections = answers.values();
  const values = inputs.values();
  return {
    select: vi
      .fn<ElicitationUIContext["select"]>()
      .mockImplementation(async () => selections.next().value),
    input: vi
      .fn<ElicitationUIContext["input"]>()
      .mockImplementation(async () => values.next().value),
    notify: vi.fn<ElicitationUIContext["notify"]>(),
  };
}
