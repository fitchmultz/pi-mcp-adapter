export interface ParsedInvocation {
  packageSpec: string;
  binName?: string;
  extraArgs: string[];
}
export interface ParsedPackageSpec {
  packageName: string;
  exactVersion?: string;
}
const EXACT_PACKAGE_VERSION_RE =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

type Option =
  | { kind: "yes" }
  | { kind: "package"; value: string; consumed: number }
  | { kind: "positional" }
  | { kind: "invalid" };

function separatedPackage(next: string | undefined): Option {
  return next === undefined || next === "" || next.startsWith("-")
    ? { kind: "invalid" }
    : { kind: "package", value: next, consumed: 1 };
}

function readOption(arg: string, next: string | undefined, shortPackage: boolean): Option {
  if (arg === "-y" || arg === "--yes") {
    return { kind: "yes" };
  }
  if (arg === "--package" || (shortPackage && arg === "-p")) {
    return separatedPackage(next);
  }
  if (arg.startsWith("--package=")) {
    const value = arg.slice("--package=".length);
    return value === "" ? { kind: "invalid" } : { kind: "package", value, consumed: 0 };
  }
  return { kind: arg.startsWith("-") ? "invalid" : "positional" };
}

function leadingOptions(
  args: string[],
  stopAtPositional: boolean,
): {
  packageSpec?: string;
  positionals: string[];
} | null {
  let packageSpec: string | undefined;
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) {
      return null;
    }
    const option = readOption(arg, args[i + 1], stopAtPositional);
    switch (option.kind) {
      case "invalid":
        return null;
      case "yes":
        break;
      case "package":
        packageSpec ??= option.value;
        i += option.consumed;
        break;
      case "positional":
        if (stopAtPositional) {
          positionals.push(...args.slice(i));
          return { ...(packageSpec !== undefined ? { packageSpec } : {}), positionals };
        }
        break;
    }
  }
  return { ...(packageSpec !== undefined ? { packageSpec } : {}), positionals };
}

function parseNpxArgs(args: string[]): ParsedInvocation | null {
  const separatorIndex = args.indexOf("--");
  const before = separatorIndex >= 0 ? args.slice(0, separatorIndex) : args;
  const after = separatorIndex >= 0 ? args.slice(separatorIndex + 1) : [];
  const options = leadingOptions(before, true);
  if (!options) {
    return null;
  }
  const positional = options.positionals[0];
  if (positional === undefined || positional === "") {
    return null;
  }
  const extraArgs = options.positionals
    .slice(1)
    .concat(after.length > 0 ? ["--", ...after] : after);
  return options.packageSpec === undefined
    ? { packageSpec: positional, extraArgs }
    : { packageSpec: options.packageSpec, binName: positional, extraArgs };
}

function parseNpmExecArgs(args: string[]): ParsedInvocation | null {
  if (args[0] !== "exec") {
    return null;
  }
  const execArgs = args.slice(1);
  const separatorIndex = execArgs.indexOf("--");
  if (separatorIndex < 0) {
    return null;
  }
  const options = leadingOptions(execArgs.slice(0, separatorIndex), false);
  const after = execArgs.slice(separatorIndex + 1);
  const binName = after[0];
  if (options?.packageSpec === undefined || binName === undefined || binName === "") {
    return null;
  }
  return { packageSpec: options.packageSpec, binName, extraArgs: after.slice(1) };
}

export function parseInvocation(command: string, args: string[]): ParsedInvocation | null {
  if (command === "npx") {
    return parseNpxArgs(args);
  }
  return command === "npm" ? parseNpmExecArgs(args) : null;
}

function splitPackageVersion(
  spec: string,
): { packageName: string; requestedVersion?: string } | null {
  if (spec.startsWith("@") && !spec.includes("/")) {
    return null;
  }
  const index = spec.startsWith("@") ? spec.lastIndexOf("@") : spec.indexOf("@");
  const hasVersion = spec.startsWith("@") ? index > spec.indexOf("/") : index >= 0;
  return hasVersion
    ? { packageName: spec.slice(0, index), requestedVersion: spec.slice(index + 1) }
    : { packageName: spec };
}

export function parsePackageSpec(spec: string): ParsedPackageSpec | null {
  const trimmed = spec.trim();
  if (trimmed === "") {
    return null;
  }
  const split = splitPackageVersion(trimmed);
  if (!split || split.packageName === "") {
    return null;
  }
  const exactVersion = split.requestedVersion?.replace(/^=/, "").replace(/^v/i, "");
  if (
    split.requestedVersion !== undefined &&
    (exactVersion === undefined ||
      exactVersion === "" ||
      !EXACT_PACKAGE_VERSION_RE.test(exactVersion))
  ) {
    return null;
  }
  return {
    packageName: split.packageName,
    ...(exactVersion !== undefined ? { exactVersion } : {}),
  };
}
