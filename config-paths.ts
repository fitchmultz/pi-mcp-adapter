import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAdapterPath, getAgentPath } from "./agent-dir.ts";
import type { ImportKind } from "./config-types.ts";
import type { ConfigSourceSpec } from "./config-contracts.ts";

export const GENERIC_GLOBAL_CONFIG_PATH = join(homedir(), ".config", "mcp", "mcp.json");
const AGENTS_GLOBAL_CONFIG_PATHS: readonly string[] = [
  join(homedir(), ".agents", "mcp.json"),
  join(homedir(), ".agents", "mcp", "mcp.json"),
];
const PROJECT_CONFIG_NAME = ".mcp.json";
const PROJECT_NATIVE_PI_CONFIG_NAME = ".pi/mcp.json";
const PROJECT_PI_CONFIG_NAME = ".pi/fitch-mcp-adapter/mcp.json";
const PROJECT_CONFIG_MARKERS = [
  PROJECT_CONFIG_NAME,
  PROJECT_NATIVE_PI_CONFIG_NAME,
  PROJECT_PI_CONFIG_NAME,
] as const;
export const REPOPROMPT_BINARY_CANDIDATES = [
  join(homedir(), "RepoPrompt", "repoprompt_cli"),
  "/Applications/Repo Prompt.app/Contents/MacOS/repoprompt-mcp",
];

export const IMPORT_PATHS: Record<ImportKind, string[]> = {
  cursor: [join(homedir(), ".cursor", "mcp.json")],
  "claude-code": [
    join(homedir(), ".claude", "mcp.json"),
    join(homedir(), ".claude.json"),
    join(homedir(), ".claude", "claude_desktop_config.json"),
  ],
  "claude-desktop": [
    join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json"),
  ],
  codex: [join(homedir(), ".codex", "config.toml"), join(homedir(), ".codex", "config.json")],
  opencode: [join(homedir(), ".config", "opencode", "opencode.json"), "./opencode.json"],
  windsurf: [join(homedir(), ".windsurf", "mcp.json")],
  vscode: [".vscode/mcp.json"],
};

export function getPiGlobalConfigPath(overridePath?: string): string {
  return overridePath !== undefined && overridePath !== ""
    ? resolve(overridePath)
    : getAdapterPath("mcp.json");
}

export function getGlobalNativePiConfigPath(): string {
  return getAgentPath("mcp.json");
}

function walkProjectConfigDirs(cwd: string): string[] {
  const start = resolve(cwd);
  if (isHomePath(start)) {
    return [start];
  }
  const dirs: string[] = [];
  let current = start;
  while (true) {
    if (isHomePath(current)) {
      break;
    }
    dirs.push(current);
    if (existsSync(join(current, ".git"))) {
      return dirs;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  // Outside a Git repository, stay inside cwd rather than walking up to shared ancestors like /tmp.
  return [start];
}

function resolveProjectConfigPath(cwd: string, relativePath: string): string {
  const dirs = walkProjectConfigDirs(cwd);
  for (const dir of dirs) {
    const candidate = join(dir, relativePath);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  const fallbackDir =
    dirs.find((dir) => PROJECT_CONFIG_MARKERS.some((marker) => existsSync(join(dir, marker)))) ??
    dirs.find((dir) => existsSync(join(dir, ".git"))) ??
    dirs[0] ??
    resolve(cwd);
  return join(fallbackDir, relativePath);
}

export function getProjectConfigPath(cwd = process.cwd()): string {
  return resolveProjectConfigPath(cwd, PROJECT_CONFIG_NAME);
}

export function getProjectNativePiConfigPath(cwd = process.cwd()): string {
  return resolveProjectConfigPath(cwd, PROJECT_NATIVE_PI_CONFIG_NAME);
}

export function getProjectPiConfigPath(cwd = process.cwd()): string {
  return resolveProjectConfigPath(cwd, PROJECT_PI_CONFIG_NAME);
}

function canonicalPath(path: string): string {
  const resolvedPath = resolve(path);
  let existingPath = resolvedPath;
  while (!existsSync(existingPath)) {
    const parent = dirname(existingPath);
    if (parent === existingPath) {
      return resolvedPath;
    }
    existingPath = parent;
  }

  try {
    return resolve(realpathSync(existingPath), relative(existingPath, resolvedPath));
  } catch {
    return resolvedPath;
  }
}

export function isPathInsideProject(path: string, cwd: string): boolean {
  const projectRoots = findProjectRoots(cwd);
  const roots = projectRoots.length > 0 ? projectRoots : fallbackProjectRoots(cwd);
  const contains = (root: string, candidate: string): boolean => {
    const pathFromRoot = relative(root, candidate);
    return (
      pathFromRoot === "" ||
      (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
    );
  };
  return roots.some(
    (root) =>
      contains(resolve(root), resolve(path)) || contains(canonicalPath(root), canonicalPath(path)),
  );
}

function fallbackProjectRoots(cwd: string): string[] {
  return isHomePath(cwd) ? [] : [cwd];
}

export function isProjectConfigSource(source: ConfigSourceSpec, cwd: string): boolean {
  return source.scope === "project" || isPathInsideProject(source.readPath, cwd);
}

function getGlobalConfigSources(userPath: string, globalNativePiPath: string): ConfigSourceSpec[] {
  const sources: ConfigSourceSpec[] = [];
  if (GENERIC_GLOBAL_CONFIG_PATH !== userPath) {
    sources.push({
      id: "shared-global",
      label: "user-global standard MCP",
      readPath: GENERIC_GLOBAL_CONFIG_PATH,
      writePath: userPath,
      kind: "import",
      importKind: "global MCP config",
      shared: true,
      scope: "global",
    });
  }
  sources.push(...getAgentsGlobalSources(userPath));
  if (
    globalNativePiPath !== userPath &&
    globalNativePiPath !== GENERIC_GLOBAL_CONFIG_PATH &&
    !AGENTS_GLOBAL_CONFIG_PATHS.includes(globalNativePiPath)
  ) {
    sources.push({
      id: "native-pi-global",
      label: "user-global native Pi MCP",
      readPath: globalNativePiPath,
      writePath: userPath,
      kind: "user",
      shared: true,
      scope: "global",
    });
  }
  sources.push({
    id: "pi-global",
    label: "Pi global override",
    readPath: userPath,
    writePath: userPath,
    kind: "user",
    shared: false,
    scope: "global",
  });
  return sources;
}

function getProjectConfigSources(paths: {
  readonly userPath: string;
  readonly globalNativePiPath: string;
  readonly projectPath: string;
  readonly projectNativePiPath: string;
  readonly projectPiPath: string;
}): ConfigSourceSpec[] {
  const { userPath, globalNativePiPath, projectPath, projectNativePiPath, projectPiPath } = paths;
  const sources: ConfigSourceSpec[] = [];
  if (projectPath !== userPath) {
    sources.push({
      id: "shared-project",
      label: "project standard MCP",
      readPath: projectPath,
      writePath: projectPiPath,
      kind: "project",
      shared: true,
      scope: "project",
    });
  }
  if (
    projectNativePiPath !== userPath &&
    projectNativePiPath !== globalNativePiPath &&
    projectNativePiPath !== projectPath &&
    projectNativePiPath !== projectPiPath
  ) {
    sources.push({
      id: "native-pi-project",
      label: "project native Pi MCP",
      readPath: projectNativePiPath,
      writePath: projectPiPath,
      kind: "project",
      shared: true,
      scope: "project",
    });
  }
  if (projectPiPath !== userPath && projectPiPath !== projectPath) {
    sources.push({
      id: "pi-project",
      label: "project Pi override",
      readPath: projectPiPath,
      writePath: projectPiPath,
      kind: "project",
      shared: false,
      scope: "project",
    });
  }
  return sources;
}

export function getConfigSources(overridePath?: string, cwd = process.cwd()): ConfigSourceSpec[] {
  const userPath = getPiGlobalConfigPath(overridePath);
  const globalNativePiPath = getGlobalNativePiConfigPath();
  return [
    ...getGlobalConfigSources(userPath, globalNativePiPath),
    ...getProjectConfigSources({
      userPath,
      globalNativePiPath,
      projectPath: getProjectConfigPath(cwd),
      projectNativePiPath: getProjectNativePiConfigPath(cwd),
      projectPiPath: getProjectPiConfigPath(cwd),
    }),
  ];
}

function getAgentsGlobalSources(userPath: string): ConfigSourceSpec[] {
  return AGENTS_GLOBAL_CONFIG_PATHS.flatMap((agentsPath, index) => {
    if (agentsPath === userPath || agentsPath === GENERIC_GLOBAL_CONFIG_PATH) {
      return [];
    }
    return [
      {
        id: index === 0 ? "agents-global" : "agents-nested-global",
        label: index === 0 ? "user-global .agents MCP" : "user-global .agents nested MCP",
        readPath: agentsPath,
        writePath: userPath,
        kind: "import",
        importKind: index === 0 ? ".agents MCP config" : ".agents/mcp MCP config",
        shared: true,
        scope: "global",
      },
    ];
  });
}

export function isHomePath(path: string): boolean {
  const home = resolve(homedir());
  return resolve(path) === home || canonicalPath(path) === canonicalPath(home);
}

export function findProjectRoots(cwd = process.cwd()): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const startPaths = new Set([resolve(cwd), canonicalPath(cwd)]);

  for (const startPath of startPaths) {
    let current = startPath;
    while (true) {
      if (
        !isHomePath(current) &&
        [".git", "package.json", PROJECT_CONFIG_NAME, ".pi"].some((marker) =>
          existsSync(join(current, marker)),
        ) &&
        !seen.has(current)
      ) {
        roots.push(current);
        seen.add(current);
      }

      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  return roots;
}

export function findProjectRoot(cwd = process.cwd()): string | null {
  return findProjectRoots(cwd)[0] ?? null;
}
