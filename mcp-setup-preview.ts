import { visibleWidth } from "@earendil-works/pi-tui";
import type { ConfigWritePreview, McpDiscoverySummary } from "./config.ts";
import type { ImportKind } from "./types.ts";
import type { Action, SetupPanelCallbacks } from "./mcp-setup-contract.ts";
import { getDetectedPaths } from "./mcp-setup-actions.ts";
export function wrapSetupText(text: string, width: number): string[] {
  if (width <= 8) {
    return [text];
  }
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current.length > 0 ? `${current} ${word}` : word;
    if (visibleWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current.length > 0) {
      lines.push(current);
    }
    current = word;
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines.length > 0 ? lines : [""];
}

interface PreviewState {
  discovery: McpDiscoverySummary;
  callbacks: SetupPanelCallbacks;
  selectedImports: ReadonlySet<ImportKind>;
}

export class SetupPreview {
  private readonly state: PreviewState;
  constructor(state: PreviewState) {
    this.state = state;
  }
  getActionPreview(action: Action | undefined, previewW: number): string[] {
    switch (action?.id) {
      case "run-setup":
        return this.formatPreview(
          [
            "Run setup to adopt host-specific imports, inspect detected paths, and scaffold a minimal `.mcp.json` if needed.",
          ],
          previewW,
        );
      case "adopt-imports":
        return this.formatWritePreview(
          "Compatibility import write preview",
          this.state.callbacks.previewImports(
            this.state.discovery.imports
              .filter((entry) => this.state.selectedImports.has(entry.kind))
              .map((entry) => entry.kind),
          ),
          [
            `Detected imports: ${this.state.discovery.imports.map((entry) => `${entry.kind} (${entry.serverCount} servers)`).join(", ")}`,
            "Selected imports are written into the Pi agent dir config as Pi-owned compatibility state.",
          ],
          previewW,
        );
      case "view-example":
      case "show-precedence":
        return this.referencePreview(action.id, previewW);
      case "open-paths":
        return this.formatPreview(
          getDetectedPaths(this.state.discovery).length > 0
            ? ["Detected paths:", ...getDetectedPaths(this.state.discovery)]
            : ["No config paths were detected."],
          previewW,
        );
      case "add-repoprompt": {
        const repoPrompt = this.state.discovery.repoPrompt;
        const preview = this.state.callbacks.previewRepoPrompt();
        if (!preview) {
          return this.formatPreview(
            ["RepoPrompt is not available to add from this setup screen."],
            previewW,
          );
        }
        return this.formatWritePreview(
          "RepoPrompt write preview",
          preview,
          [
            `Executable: ${repoPrompt.executablePath ?? "not found"}`,
            `Target: ${repoPrompt.targetPath ?? "n/a"}`,
            `Server name: ${repoPrompt.serverName ?? "repoprompt"}`,
          ],
          previewW,
        );
      }
      case "add-known-server": {
        const preset = action.preset;
        if (!preset) {
          return this.formatPreview(["Known server preset is unavailable."], previewW);
        }
        return this.formatWritePreview(
          `${preset.name} write preview`,
          this.state.callbacks.previewKnownServer(preset),
          [preset.summary],
          previewW,
        );
      }
      case "scaffold-project":
        return this.formatWritePreview(
          "Starter project `.mcp.json` write preview",
          this.state.callbacks.previewStarterProject(),
          [
            "This writes a minimal `.mcp.json` in the current project using the shared MCP layout.",
            "It intentionally avoids adding a fake placeholder server that would fail on first reload.",
          ],
          previewW,
        );
      case "close":
      case undefined:
        return this.formatPreview(["Close the setup flow."], previewW);
    }
  }

  private referencePreview(id: "view-example" | "show-precedence", previewW: number): string[] {
    if (id === "view-example") {
      return this.formatPreview(
        [
          "Example shared `.mcp.json`:",
          "{",
          '  "mcpServers": {',
          '    "chrome-devtools": {',
          '      "command": "npx",',
          '      "args": ["-y", "chrome-devtools-mcp"]',
          "    }",
          "  }",
          "}",
          "",
          "Use Scaffold project `.mcp.json` when you want a safe empty shell instead of a live example server.",
        ],
        previewW,
      );
    }
    return this.formatPreview(
      [
        "Read order (later entries win):",
        "0. detected host configs (opt-in lowest-precedence fallback)",
        "1. ~/.config/mcp/mcp.json",
        "2. ~/.agents/mcp.json",
        "3. ~/.agents/mcp/mcp.json",
        "4. <Pi agent dir>/fitch-mcp-adapter/mcp.json",
        "5. .mcp.json",
        "6. .pi/fitch-mcp-adapter/mcp.json",
        `Host discovery: ${this.state.discovery.hostConfigDiscovery}. Conflicts reported: ${this.state.discovery.conflicts.length}.`,
        ...this.state.discovery.conflicts
          .slice(0, 8)
          .map(
            (conflict) =>
              `${conflict.serverName}: ${conflict.sources.map((source) => source.path).join(" -> ")} (winner: ${conflict.winner.path})`,
          ),
        "Pi writes compatibility imports and adapter-only overrides to Pi-owned files.",
      ],
      previewW,
    );
  }

  formatPreview(lines: string[], width: number): string[] {
    const preview: string[] = [];
    for (const line of lines) {
      preview.push(...wrapSetupText(line, width));
    }
    return preview;
  }

  formatWritePreview(
    title: string,
    preview: ConfigWritePreview,
    intro: string[],
    width: number,
  ): string[] {
    const lines: string[] = [];
    for (const line of intro) {
      lines.push(...wrapSetupText(line, width));
    }
    if (intro.length > 0) {
      lines.push("");
    }
    lines.push(...wrapSetupText(`${title}: ${preview.path}`, width));
    lines.push(
      ...wrapSetupText(
        preview.existed
          ? "Existing file detected. Showing exact before/after diff."
          : "New file will be created. Showing exact content diff.",
        width,
      ),
    );
    lines.push("");
    const diffLines = preview.diffText.split("\n");
    const maxLines = 18;
    const shown = diffLines.slice(0, maxLines);
    for (const line of shown) {
      lines.push(...wrapSetupText(line, width));
    }
    if (diffLines.length > maxLines) {
      lines.push(
        ...wrapSetupText(
          `… ${diffLines.length - maxLines} more diff line${diffLines.length - maxLines === 1 ? "" : "s"}`,
          width,
        ),
      );
    }
    return lines;
  }
}
