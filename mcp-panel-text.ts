import { sanitizeTerminalText, stripOscSequences } from "./utils.ts";
interface PanelTheme {
  border: string;
  title: string;
  selected: string;
  direct: string;
  needsAuth: string;
  placeholder: string;
  description: string;
  hint: string;
  confirm: string;
  cancel: string;
}

export const DEFAULT_THEME: PanelTheme = {
  border: "2",
  title: "2",
  selected: "36",
  direct: "32",
  needsAuth: "33",
  placeholder: "2;3",
  description: "2",
  hint: "2",
  confirm: "32",
  cancel: "31",
};

export function fg(code: string, text: string): string {
  if (code.length === 0) {
    return text;
  }
  return `\x1b[${code}m${text}\x1b[0m`;
}

const RAINBOW_COLORS = [
  "38;2;178;129;214",
  "38;2;215;135;175",
  "38;2;254;188;56",
  "38;2;228;192;15",
  "38;2;137;210;129",
  "38;2;0;175;175",
  "38;2;23;143;185",
];

export function rainbowProgress(filled: number, total: number): string {
  const dots: string[] = [];
  for (let i = 0; i < total; i++) {
    const color = RAINBOW_COLORS[i % RAINBOW_COLORS.length];
    if (color === undefined || color.length === 0) {
      continue;
    }
    dots.push(fg(color, i < filled ? "●" : "○"));
  }
  return dots.join(" ");
}

export function fuzzyScore(query: string, text: string): number {
  const lq = query.toLowerCase();
  const lt = text.toLowerCase();
  if (lt.includes(lq)) {
    return 100 + (lq.length / lt.length) * 50;
  }
  let score = 0;
  let qi = 0;
  let consecutive = 0;
  for (let i = 0; i < lt.length && qi < lq.length; i++) {
    if (lt[i] === lq[qi]) {
      score += 10 + consecutive;
      consecutive += 5;
      qi++;
    } else {
      consecutive = 0;
    }
  }
  return qi === lq.length ? score : 0;
}

export function sanitizeDisplayText(text: string | null | undefined): string {
  return sanitizeTerminalText(text ?? "");
}

export function sanitizeRowContent(content: string): string {
  const withoutOsc = stripOscSequences(content);
  let result = "";
  let pendingSpace = false;
  for (let i = 0; i < withoutOsc.length; i++) {
    const rest = withoutOsc.slice(i);
    const ansi = rest.match(/^(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_])/);
    if (ansi) {
      result += ansi[0];
      i += ansi[0].length - 1;
      continue;
    }

    const code = withoutOsc.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      pendingSpace = true;
      continue;
    }

    if (pendingSpace && result.length > 0 && !result.endsWith(" ")) {
      result += " ";
    }
    pendingSpace = false;
    result += withoutOsc.charAt(i);
  }
  return result;
}
