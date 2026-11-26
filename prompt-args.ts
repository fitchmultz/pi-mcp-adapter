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

interface ScannedArgToken {
  readonly value: string;
  readonly start: number;
}

class PromptArgTokenizer {
  private readonly tokens: ScannedArgToken[] = [];
  private current = "";
  private tokenStart = 0;
  private inToken = false;
  private quote: '"' | "'" | null = null;
  private escaped = false;

  private startToken(index: number): void {
    if (!this.inToken) {
      this.tokenStart = index;
      this.inToken = true;
    }
  }

  private flushToken(): void {
    if (this.inToken) {
      if (this.current.length > 0) {
        this.tokens.push({ value: this.current, start: this.tokenStart });
      }
      this.current = "";
      this.inToken = false;
    }
  }

  private step(index: number, char: string): void {
    if (this.escaped) {
      this.current += char;
      this.escaped = false;
      return;
    }
    if (char === "\\" && this.quote !== "'") {
      this.startToken(index);
      this.escaped = true;
      return;
    }
    if (this.quote !== null) {
      this.current += char;
      if (char === this.quote) {
        this.quote = null;
      }
      return;
    }
    this.stepUnquoted(index, char);
  }

  private stepUnquoted(index: number, char: string): void {
    if (isQuote(char)) {
      this.startToken(index);
      this.quote = char;
      this.current += char;
      return;
    }
    if (/\s/.test(char)) {
      this.flushToken();
      return;
    }
    this.startToken(index);
    this.current += char;
  }

  scan(input: string): {
    readonly tokens: ScannedArgToken[];
    readonly activeStart: number | null;
  } {
    for (let i = 0; i < input.length; i++) {
      this.step(i, input.charAt(i));
    }
    const activeStart = this.inToken ? this.tokenStart : null;
    this.flushToken();
    return { tokens: this.tokens, activeStart };
  }
}

function scanArgs(input: string): {
  readonly tokens: ScannedArgToken[];
  readonly activeStart: number | null;
} {
  return new PromptArgTokenizer().scan(input);
}

/**
 * Split an in-progress slash-command argument string into completed tokens
 * before the cursor, the raw prefix to preserve before the active token, and
 * the active token currently being typed.
 */
export function splitActiveArgument(input: string): ActiveArgumentSplit {
  const { tokens, activeStart } = scanArgs(input);
  if (activeStart === null) {
    return {
      priorTokens: tokens.map((token) => token.value),
      prefixBeforeActive: input,
      activeToken: "",
    };
  }
  const completed = tokens.filter((token) => token.start < activeStart);
  return {
    priorTokens: completed.map((token) => token.value),
    prefixBeforeActive: input.slice(0, activeStart),
    activeToken: input.slice(activeStart),
  };
}

function tokenizeArgs(input: string): string[] {
  return scanArgs(input).tokens.map((token) => token.value);
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
