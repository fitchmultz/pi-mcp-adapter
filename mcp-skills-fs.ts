import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "./agent-dir.ts";
import { logger } from "./logger.ts";
import type { VerifiedSkillBundle } from "./mcp-skills.ts";
import type { SkillMetadata } from "./types.ts";

const SKILLS_DIR_NAME = "mcp-skills";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function errnoCode(error: unknown): unknown {
  return typeof error === "object" && error !== null
    ? Object.getOwnPropertyDescriptor(error, "code")?.value
    : undefined;
}

export function safeRemovePath(targetPath: string, contextLabel?: string): void {
  try {
    rmSync(targetPath, { recursive: true, force: true });
  } catch (error: unknown) {
    if (contextLabel !== undefined) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`MCP: failed to clean skills directory ${contextLabel}: ${message}`);
    }
  }
}

function isDeadRuntimeDirName(name: string): boolean {
  const match = /^(\d+)-/.exec(name);
  const pid = Number(match?.[1]);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error: unknown) {
    return errnoCode(error) === "ESRCH";
  }
}

export function pruneDeadRuntimeDirs(rootDir: string, currentRuntimeId: string): void {
  try {
    for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        entry.name !== currentRuntimeId &&
        isDeadRuntimeDirName(entry.name)
      ) {
        safeRemovePath(assertWithinParent(rootDir, join(rootDir, entry.name)));
      }
    }
  } catch {
    // Best-effort residue pruning must never block live skill materialization.
  }
}

function ensurePrivateDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true, mode: DIR_MODE });
  chmodSync(dirPath, DIR_MODE);
}

export function assertWithinParent(parentDir: string, childPath: string): string {
  const resolvedParent = resolve(parentDir);
  const resolvedChild = resolve(childPath);
  if (!resolvedChild.startsWith(`${resolvedParent}${sep}`)) {
    throw new Error(`Path escapes adapter skills directory: ${childPath}`);
  }
  return resolvedChild;
}

function sanitizeServerDirName(serverName: string): string {
  const cleaned = serverName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeBase =
    cleaned === "" || cleaned === "." || cleaned === ".." ? "server" : cleaned.slice(0, 48);
  const digest = createHash("sha256").update(serverName, "utf8").digest("hex").slice(0, 8);
  return `${safeBase}-${digest}`;
}

export function createSkillsRuntimeId(): string {
  return `${process.pid}-${randomUUID()}`;
}

export function getSkillsRootDir(): string {
  return join(getAgentDir(), SKILLS_DIR_NAME);
}

export function getRuntimeSkillsDir(runtimeId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(runtimeId)) {
    throw new Error(`Unsafe skills runtime identifier: ${runtimeId}`);
  }
  return assertWithinParent(getSkillsRootDir(), join(getSkillsRootDir(), runtimeId));
}

export function getServerSkillsDir(runtimeId: string, serverName: string): string {
  const runtimeDir = getRuntimeSkillsDir(runtimeId);
  return assertWithinParent(runtimeDir, join(runtimeDir, sanitizeServerDirName(serverName)));
}

function swapDirectoryIntoPlace(stageDir: string, serverDir: string): void {
  const backupDir = `${serverDir}.old-${randomUUID()}`;
  let movedExisting = false;
  try {
    renameSync(serverDir, backupDir);
    movedExisting = true;
  } catch (error: unknown) {
    if (errnoCode(error) !== "ENOENT") {
      throw error;
    }
  }
  try {
    renameSync(stageDir, serverDir);
    ensurePrivateDir(serverDir);
  } catch (error) {
    if (movedExisting) {
      try {
        renameSync(backupDir, serverDir);
      } catch {
        // Ignore rollback errors after original rename failure.
      }
    }
    throw error;
  }
  if (movedExisting) {
    safeRemovePath(backupDir);
  }
}

function materializeSingleSkill(
  serverStageDir: string,
  bundle: VerifiedSkillBundle,
  serverName: string,
): { metadata: SkillMetadata; dir: string } | null {
  const skillDir = assertWithinParent(serverStageDir, join(serverStageDir, bundle.dirName));
  ensurePrivateDir(skillDir);
  for (const file of bundle.files) {
    const filePath = assertWithinParent(skillDir, join(skillDir, ...file.relativeSegments));
    mkdirSync(dirname(filePath), { recursive: true, mode: DIR_MODE });
    writeFileSync(filePath, file.content, { mode: FILE_MODE, flag: "wx" });
  }
  const loaded = loadSkillsFromDir({ dir: skillDir, source: "mcp" });
  if (loaded.skills.length !== 1 || loaded.skills[0]?.name !== bundle.dirName) {
    rmSync(skillDir, { recursive: true, force: true });
    logger.warn(
      `MCP: skipped skill "${bundle.dirName}" from ${serverName} — rejected by Pi skill loader`,
    );
    return null;
  }
  return { metadata: bundle.metadata, dir: skillDir };
}

export function materializeVerifiedSkills(input: {
  readonly runtimeId: string;
  readonly serverName: string;
  readonly bundles: readonly VerifiedSkillBundle[];
}): { metadata: SkillMetadata[]; paths: string[] } {
  const { runtimeId, serverName, bundles } = input;
  const rootDir = getSkillsRootDir();
  const runtimeDir = getRuntimeSkillsDir(runtimeId);
  ensurePrivateDir(rootDir);
  ensurePrivateDir(runtimeDir);

  const serverSlug = sanitizeServerDirName(serverName);
  const serverDir = assertWithinParent(runtimeDir, join(runtimeDir, serverSlug));
  const stageDir = assertWithinParent(
    runtimeDir,
    join(runtimeDir, `.stage-${serverSlug}-${randomUUID()}`),
  );
  ensurePrivateDir(stageDir);

  const accepted: SkillMetadata[] = [];
  const relativeSkillDirs: string[] = [];
  try {
    for (const bundle of bundles) {
      const result = materializeSingleSkill(stageDir, bundle, serverName);
      if (result) {
        accepted.push(result.metadata);
        relativeSkillDirs.push(bundle.dirName);
      }
    }
    if (accepted.length === 0) {
      safeRemovePath(stageDir);
      safeRemovePath(serverDir, serverName);
      return { metadata: [], paths: [] };
    }
    swapDirectoryIntoPlace(stageDir, serverDir);
    return {
      metadata: accepted,
      paths: relativeSkillDirs.map((dirName) =>
        assertWithinParent(serverDir, join(serverDir, dirName)),
      ),
    };
  } catch (error) {
    safeRemovePath(stageDir);
    throw error;
  }
}
