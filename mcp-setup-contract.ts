import type { PanelKeybindings } from "./panel-keys.ts";
import type { ImportKind } from "./types.ts";
import type { ConfigWritePreview, KnownServerPreset } from "./config.ts";
import type { McpOnboardingState } from "./onboarding-state.ts";

export interface SetupPanelCallbacks {
  previewImports: (imports: ImportKind[]) => ConfigWritePreview;
  previewStarterProject: () => ConfigWritePreview;
  previewRepoPrompt: () => ConfigWritePreview | null;
  previewKnownServer: (preset: KnownServerPreset) => ConfigWritePreview;
  adoptImports: (imports: ImportKind[]) => Promise<{ added: ImportKind[]; path: string }>;
  scaffoldProjectConfig: () => Promise<{ path: string }>;
  addRepoPrompt: () => Promise<{ path: string; serverName: string }>;
  addKnownServer: (preset: KnownServerPreset) => Promise<{ path: string; serverName: string }>;
  openPath: (path: string) => Promise<void>;
  markSetupCompleted: () => void;
}

export interface SetupPanelOptions {
  mode: "empty" | "setup";
  onboardingState: McpOnboardingState;
  keybindings?: PanelKeybindings;
}

export type Screen = "empty" | "setup" | "imports" | "paths";

type ActionId =
  | "run-setup"
  | "adopt-imports"
  | "view-example"
  | "show-precedence"
  | "open-paths"
  | "add-repoprompt"
  | "add-known-server"
  | "scaffold-project"
  | "close";

export interface Action {
  id: ActionId;
  label: string;
  description: string;
  preset?: KnownServerPreset;
}
