import type { PromptMetadata } from "./types.ts";

export interface ResolvedPromptArgs {
  ok: boolean;
  /** Present when `ok === true`. */
  args?: Record<string, string>;
  /** Present when `ok === false`. */
  error?: string;
}

export interface ActiveArgumentSplit {
  priorTokens: string[];
  prefixBeforeActive: string;
  activeToken: string;
}

/**
 * Parse a slash-command argument string into positional and named MCP prompt
 * arguments. Supports bash-style quoting so callers can pass values with
 * spaces:
 *
 *   /mcp__demo__brief today "important tasks"
 *   /mcp__demo__brief day=today topic="important tasks"
 */
export function parsePromptArgs(input: string): {
  positional: string[];
  named: Record<string, string>;
} {
  return parsePromptTokens(tokenizeArgs(input));
}

export function parsePromptTokens(tokens: readonly string[]): {
  positional: string[];
  named: Record<string, string>;
} {
  const positional: string[] = [];
  const named: Record<string, string> = {};

  for (const token of tokens) {
    const eq = findUnquotedEquals(token);
    if (eq > 0) {
      const key = token.slice(0, eq).trim();
      const value = stripQuotes(token.slice(eq + 1).trim());
      if (key !== "") {
        named[key] = value;
        continue;
      }
    }
    positional.push(stripQuotes(token));
  }

  return { positional, named };
}

class ActiveArgumentScanner {
  private readonly input: string;
  private readonly tokens: string[] = [];
  private quote: '"' | "'" | null = null;
  private escaped = false;
  private tokenStart = 0;
  private inToken = false;

  constructor(input: string) {
    this.input = input;
  }

  private markStart(index: number): void {
    if (!this.inToken) {
      this.tokenStart = index;
      this.inToken = true;
    }
  }

  private step(index: number, char: string): void {
    if (this.escaped) {
      this.escaped = false;
      return;
    }
    if (char === "\\" && this.quote !== "'") {
      this.markStart(index);
      this.escaped = true;
      return;
    }
    if (this.quote !== null) {
      if (char === this.quote) {
        this.quote = null;
      }
      return;
    }
    this.stepUnquoted(index, char);
  }

  private stepUnquoted(index: number, char: string): void {
    if (isQuote(char)) {
      this.markStart(index);
      this.quote = char;
      return;
    }
    if (/\s/.test(char)) {
      if (this.inToken) {
        this.tokens.push(this.input.slice(this.tokenStart, index));
        this.inToken = false;
      }
      return;
    }
    this.markStart(index);
  }

  scan(): ActiveArgumentSplit {
    for (let i = 0; i < this.input.length; i++) {
      this.step(i, this.input.charAt(i));
    }
    if (this.inToken) {
      return {
        priorTokens: this.tokens,
        prefixBeforeActive: this.input.slice(0, this.tokenStart),
        activeToken: this.input.slice(this.tokenStart),
      };
    }
    return { priorTokens: this.tokens, prefixBeforeActive: this.input, activeToken: "" };
  }
}

/**
 * Split an in-progress slash-command argument string into completed tokens
 * before the cursor, the raw prefix to preserve before the active token, and
 * the active token currently being typed.
 */
export function splitActiveArgument(input: string): ActiveArgumentSplit {
  return new ActiveArgumentScanner(input).scan();
}

function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (isQuote(char)) {
      quote = char;
      current += char;
      continue;
    }
    if (/\s/.test(char)) {
      appendToken(tokens, current);
      current = "";
      continue;
    }
    current += char;
  }

  appendToken(tokens, current);
  return tokens;
}

function appendToken(tokens: string[], token: string): void {
  if (token.length > 0) {
    tokens.push(token);
  }
}

function isQuote(value: string): value is "'" | '"' {
  return value === "'" || value === '"';
}

export function findUnquotedEquals(token: string): number {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < token.length; i++) {
    const ch = token[i];
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "=") {
      return i;
    }
  }
  return -1;
}

export function stripQuotes(value: string): string {
  if (
    value.length >= 2 &&
    (value.startsWith('"') || value.startsWith("'")) &&
    value.endsWith(value.charAt(0))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** Strip matching quotes or an unclosed leading quote from a partial token. */
export function unquotePartial(value: string): string {
  const stripped = stripQuotes(value);
  if (stripped !== value) {
    return stripped;
  }
  if (value.startsWith('"') || value.startsWith("'")) {
    return value.slice(1);
  }
  return value;
}

/**
 * Map positional and named arguments onto the prompt's declared argument
 * list. Named arguments win over positional when both target the same slot.
 * Missing required arguments produce a helpful usage message that the
 * command handler surfaces via `ctx.ui.notify`.
 */
export function resolvePromptArgs(
  metadata: PromptMetadata,
  parsed: { positional: string[]; named: Record<string, string> },
): ResolvedPromptArgs {
  const args: Record<string, string> = {};

  const declared = metadata.arguments;
  let positionalIndex = 0;
  for (const argDef of declared) {
    const value = parsed.named[argDef.name] ?? parsed.positional[positionalIndex++];
    if (value !== undefined && value !== "") {
      args[argDef.name] = value;
    }
  }

  // Preserve named arguments the prompt did not declare so servers with
  // permissive schemas still receive them. The MCP spec allows arbitrary
  // string key/values in `prompts/get` params.arguments.
  for (const [key, value] of Object.entries(parsed.named)) {
    if (!(key in args)) {
      args[key] = value;
    }
  }

  const missing = declared.filter(
    (a) => a.required === true && (args[a.name] === undefined || args[a.name] === ""),
  );
  if (missing.length > 0) {
    return { ok: false, error: buildUsageMessage(metadata, missing) };
  }

  return { ok: true, args };
}

function buildUsageMessage(metadata: PromptMetadata, missing: PromptMetadata["arguments"]): string {
  const usage = metadata.arguments
    .map((a) => (a.required === true ? `<${a.name}>` : `[${a.name}]`))
    .join(" ");
  const missingList = missing.map((a) => a.name).join(", ");
  return `Missing required argument${missing.length > 1 ? "s" : ""}: ${missingList}.\nUsage: /${metadata.commandName} ${usage}`.trim();
}
