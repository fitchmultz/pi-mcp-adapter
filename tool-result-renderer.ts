import {
  truncateToVisualLines,
  type AgentToolResult,
  type KeybindingHints,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { asObjectRecord } from "./mcp-output-values.ts";

type McpToolResultDetails = Record<string, unknown> & { error?: unknown };
type McpToolContentBlock = AgentToolResult<McpToolResultDetails>["content"][number];

type RenderTheme = Pick<Theme, "fg" | "bold">;

const plainTheme: RenderTheme = {
  fg: (_name, text) => text,
  bold: (text) => text,
};

export interface McpProxyToolCallInput {
  tool?: string;
  args?: string | object;
  connect?: string;
  describe?: string;
  search?: string;
  query?: string;
  uri?: string;
  ref?: string;
  includeSchemas?: boolean;
  server?: string;
  action?: string;
}

interface McpToolRenderContext extends Pick<KeybindingHints, "keyHint"> {
  isError: boolean;
}

interface McpToolCallRenderContext extends Pick<KeybindingHints, "keyHint"> {
  expanded: boolean;
  lastComponent: Component | undefined;
}

export interface McpToolResultDisplay {
  lines: string[];
  truncated: boolean;
}

const DEFAULT_MAX_CALL_INPUT_CHARS = 1500;
const DEFAULT_MAX_COLLAPSED_LINES = 3;
const DEFAULT_MAX_COLLAPSED_CHARS = 8000;
const COLLAPSED_RENDER_CHAR_SLACK = 8;

class CollapsibleText implements Component {
  private readonly fullText: Text;
  private readonly footerText: Text;
  private collapsedText: { charBudget: number; fullyIncluded: boolean; text: Text } | null = null;

  private readonly text: string;
  private readonly expanded: boolean;
  private readonly maxCollapsedLines: number;
  private readonly preTruncated: boolean;

  constructor(options: {
    text: string;
    expanded: boolean;
    maxCollapsedLines: number;
    footer: string;
    preTruncated?: boolean;
  }) {
    const { text, expanded, maxCollapsedLines, footer, preTruncated = false } = options;
    this.text = text;
    this.expanded = expanded;
    this.maxCollapsedLines = maxCollapsedLines;
    this.preTruncated = preTruncated;
    this.fullText = new Text(text, 0, 0);
    this.footerText = new Text(footer, 0, 0);
  }

  render(width: number): string[] {
    if (this.expanded) {
      return this.fullText.render(width);
    }

    const safeWidth = Math.max(1, Math.floor(width));
    const charBudget = safeWidth * (this.maxCollapsedLines + 1) * COLLAPSED_RENDER_CHAR_SLACK;
    if (!this.collapsedText || this.collapsedText.charBudget !== charBudget) {
      const prefix = this.text.length > charBudget ? this.text.slice(0, charBudget) : this.text;
      this.collapsedText = {
        charBudget,
        fullyIncluded: prefix === this.text,
        text: new Text(prefix, 0, 0),
      };
    }

    const lines = this.collapsedText.text.render(width);
    if (
      !this.preTruncated &&
      this.collapsedText.fullyIncluded &&
      lines.length <= this.maxCollapsedLines
    ) {
      return lines;
    }

    return [...lines.slice(0, this.maxCollapsedLines), ...this.footerText.render(width)];
  }

  invalidate(): void {
    // Text owns its width cache; the stored input and collapsed prefix are immutable.
  }
}

/** The rows that end a collapsed preview: an ellipsis, then the expand hint when Pi supplies one. */
function collapsedFooter(
  theme: RenderTheme,
  context: Pick<KeybindingHints, "keyHint"> | undefined,
): string {
  const ellipsis = theme.fg("muted", "…");
  if (context === undefined) {
    return ellipsis;
  }
  // Pi injects keyHint so the hint shows the user's configured keys.
  return `${ellipsis}\n${theme.fg("muted", "(")}${context.keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
}

/**
 * A collapsed call: the title, then the arguments in the rows a collapsed result gets. Arguments
 * that fit in the rows of that preview and its footer are shown whole, so a collapsed call is
 * never taller than the expanded one.
 */
class CollapsedToolCall implements Component {
  private readonly title: Text;
  private readonly footer: Text;
  private readonly styledArguments: string;
  // Pi renders a card's children on every frame and reuses its own rows while they return the
  // same strings, so the arguments are wrapped once per width.
  private cache: { width: number; lines: string[] } | undefined;

  constructor(styledTitle: string, styledArguments: string, footer: string) {
    this.title = new Text(styledTitle, 0, 0);
    this.footer = new Text(footer, 0, 0);
    this.styledArguments = styledArguments;
  }

  render(width: number): string[] {
    if (this.cache?.width !== width) {
      const footer = this.footer.render(width);
      const preview = truncateToVisualLines(
        this.styledArguments,
        DEFAULT_MAX_COLLAPSED_LINES + footer.length,
        width,
        0,
        "start",
      );
      const argumentRows =
        preview.skippedCount === 0
          ? preview.visualLines
          : [...preview.visualLines.slice(0, DEFAULT_MAX_COLLAPSED_LINES), ...footer];
      this.cache = { width, lines: [...this.title.render(width), ...argumentRows] };
    }
    return this.cache.lines;
  }

  invalidate(): void {
    this.title.invalidate();
    this.footer.invalidate();
    this.cache = undefined;
  }
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function formatJsonish(value: unknown, maxChars: number): string {
  if (typeof value === "string") {
    try {
      return truncateText(JSON.stringify(JSON.parse(value), null, 2), maxChars);
    } catch {
      return truncateText(value, maxChars);
    }
  }

  try {
    return truncateText(JSON.stringify(value, null, 2), maxChars);
  } catch {
    return truncateText(String(value), maxChars);
  }
}

function hasUsefulObjectContent(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  );
}

function hasText(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

function actionServerLabel(server: string | undefined, target: string | undefined): string {
  if (!hasText(server)) {
    return "";
  }
  return `${hasText(target) ? " @" : ""} ${server}`;
}

function actionCallLines(
  args: McpProxyToolCallInput,
  maxInputChars: number,
  action: string,
): string[] {
  const target = args.tool ?? args.query ?? args.uri ?? args.ref;
  const targetLabel = hasText(target) ? ` ${target}` : "";
  const serverLabel = actionServerLabel(args.server, target);
  let line = `mcp ${action}${targetLabel}${serverLabel}`;
  if (action === "search" && args.includeSchemas === false) {
    line += " (schemas hidden)";
  }
  return action === "call" && args.args !== undefined && args.args !== ""
    ? [line, formatJsonish(args.args, maxInputChars)]
    : [line];
}

export function formatMcpProxyToolCallLines(
  args: McpProxyToolCallInput,
  maxInputChars = DEFAULT_MAX_CALL_INPUT_CHARS,
): string[] {
  if (args.action === "ui-messages" || args.action === "status") {
    return [`mcp ${args.action}`];
  }
  if (hasText(args.action)) {
    return actionCallLines(args, maxInputChars, args.action);
  }
  if (hasText(args.tool)) {
    const target = hasText(args.server) ? `${args.tool} @ ${args.server}` : args.tool;
    const lines = [`mcp call ${target}`];
    if (args.args !== undefined && args.args !== "") {
      lines.push(formatJsonish(args.args, maxInputChars));
    }
    return lines;
  }
  return legacyActionLines(args);
}

function legacyActionLines(args: McpProxyToolCallInput): string[] {
  if (hasText(args.connect)) {
    return [`mcp connect ${args.connect}`];
  }
  if (hasText(args.describe)) {
    return [`mcp describe ${args.describe}`];
  }
  if (hasText(args.search)) {
    let line = `mcp search ${args.search}`;
    if (hasText(args.server)) {
      line += ` @ ${args.server}`;
    }
    if (args.includeSchemas === false) {
      line += " (schemas hidden)";
    }
    return [line];
  }
  return hasText(args.server) ? [`mcp list ${args.server}`] : ["mcp status"];
}

export function formatMcpDirectToolCallLines(
  displayName: string,
  args: Record<string, unknown>,
  maxInputChars = DEFAULT_MAX_CALL_INPUT_CHARS,
): string[] {
  if (!hasUsefulObjectContent(args)) {
    return [displayName];
  }
  return [displayName, formatJsonish(args, maxInputChars)];
}

/**
 * Whether Pi may keep this rendering of the call as the only one. Its HTML export renders each call
 * once and cannot expand it, so a first rendering must hold every argument. A terminal card renders
 * its call again before it first shows it, and passes the earlier component back each time.
 */
function isFirstRendering(context: McpToolCallRenderContext): boolean {
  return context.lastComponent === undefined;
}

function renderToolCallLines(
  lines: string[],
  theme: RenderTheme | undefined,
  context: McpToolCallRenderContext | undefined,
): Component {
  const activeTheme = theme ?? plainTheme;
  const [title = "mcp", ...rest] = lines;
  const styledTitle = activeTheme.fg("toolTitle", activeTheme.bold(title));
  const styledRest = rest.map((line) => activeTheme.fg("muted", line));
  if (
    context === undefined ||
    context.expanded ||
    isFirstRendering(context) ||
    styledRest.length === 0
  ) {
    return new Text([styledTitle, ...styledRest].join("\n"), 0, 0);
  }
  return new CollapsedToolCall(
    styledTitle,
    styledRest.join("\n"),
    collapsedFooter(activeTheme, context),
  );
}

export function renderMcpProxyToolCall(
  args: McpProxyToolCallInput,
  theme?: RenderTheme,
  context?: McpToolCallRenderContext,
): Component {
  return renderToolCallLines(formatMcpProxyToolCallLines(args), theme, context);
}

export function createMcpDirectToolCallRenderer(
  displayName: string,
): (
  args: Record<string, unknown>,
  theme?: RenderTheme,
  context?: McpToolCallRenderContext,
) => Component {
  return (args, theme, context) =>
    renderToolCallLines(formatMcpDirectToolCallLines(displayName, args), theme, context);
}

function blockToLines(block: McpToolContentBlock): string[] {
  if (block.type === "text") {
    return block.text.split("\n");
  }
  return [`[image: ${block.mimeType}]`];
}

class ResultPreview {
  readonly lines: string[] = [];
  truncated = false;
  private remainingChars: number;
  private readonly maxLines: number;

  constructor(maxLines: number, maxChars: number) {
    this.maxLines = maxLines;
    this.remainingChars = maxChars;
  }

  appendLine(line: string): boolean {
    if (this.lines.length >= this.maxLines || this.remainingChars <= 0) {
      this.truncated = true;
      return false;
    }
    if (line.length > this.remainingChars) {
      this.lines.push(line.slice(0, this.remainingChars));
      this.truncated = true;
      this.remainingChars = 0;
      return false;
    }
    this.lines.push(line);
    this.remainingChars -= line.length + 1;
    return true;
  }

  appendText(text: string): void {
    let start = 0;
    while (start <= text.length) {
      const newline = text.indexOf("\n", start);
      const line = newline === -1 ? text.slice(start) : text.slice(start, newline);
      if (!this.appendLine(line) || newline === -1) {
        break;
      }
      start = newline + 1;
    }
  }
}

function collectCollapsedResultLines(
  content: AgentToolResult<McpToolResultDetails>["content"],
  maxLines: number,
  maxChars: number,
): McpToolResultDisplay {
  if (content.length === 0) {
    return { lines: ["(empty result)"], truncated: false };
  }
  const preview = new ResultPreview(maxLines, maxChars);
  for (const block of content) {
    if (block.type === "text") {
      preview.appendText(block.text);
    } else {
      preview.appendLine(`[image: ${block.mimeType}]`);
    }
    if (preview.truncated) {
      break;
    }
  }
  if (preview.lines.length === 0) {
    preview.lines.push("");
  }
  if (preview.truncated && preview.lines.length >= maxLines) {
    preview.lines.push("…");
  }
  return { lines: preview.lines, truncated: preview.truncated };
}

export function formatMcpToolResultIdentity(
  details: McpToolResultDetails | undefined,
): string | null {
  if (details?.mode !== "call") {
    return null;
  }
  const server = typeof details.server === "string" ? details.server : details.hintServer;
  if (typeof server !== "string" || server === "") {
    return null;
  }
  if (typeof details.tool === "string") {
    return `MCP ${server}/${details.tool}`;
  }
  if (typeof details.resourceUri === "string") {
    return `MCP ${server} resource ${details.resourceUri}`;
  }
  if (typeof details.requestedTool === "string") {
    return `MCP ${server}/${details.requestedTool}`;
  }
  return null;
}

export function formatMcpToolResultLines(
  result: Pick<AgentToolResult<McpToolResultDetails>, "content">,
  expanded: boolean,
  maxCollapsedLines = 3,
  maxCollapsedChars = DEFAULT_MAX_COLLAPSED_CHARS,
): McpToolResultDisplay {
  if (!expanded) {
    return collectCollapsedResultLines(result.content, maxCollapsedLines, maxCollapsedChars);
  }

  const allLines = result.content.flatMap(blockToLines);
  const lines = allLines.length > 0 ? allLines : ["(empty result)"];
  return { lines, truncated: false };
}

export function renderMcpToolResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme?: RenderTheme,
  context?: McpToolRenderContext,
): Component {
  const activeTheme = theme ?? plainTheme;
  if (options.isPartial) {
    return new Text(activeTheme.fg("warning", "Running MCP tool..."), 0, 0);
  }

  const details = asObjectRecord(result.details) ?? {};
  const hasErrorDetails = Boolean(details.error);
  const expanded = options.expanded || context?.isError === true || hasErrorDetails;
  const display = formatMcpToolResultLines(result, expanded);
  const identity = formatMcpToolResultIdentity(details);
  const identityLines =
    identity !== null && identity !== "" ? [activeTheme.fg("muted", identity)] : [];
  const output = [
    ...identityLines,
    ...display.lines.map((line) => activeTheme.fg("toolOutput", line)),
  ].join("\n");

  return new CollapsibleText({
    text: output,
    expanded,
    maxCollapsedLines: DEFAULT_MAX_COLLAPSED_LINES + identityLines.length,
    footer: collapsedFooter(activeTheme, context),
    preTruncated: display.truncated,
  });
}
