import type { Client } from "@modelcontextprotocol/client";
import type * as SkillsExt from "@modelcontextprotocol/client/ext/skills";
import type { Skill, SkillListing, SkillsClient } from "@modelcontextprotocol/client/ext/skills";

type SkillsSdkModule = typeof SkillsExt;
const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";
import type { ManagedClient } from "./connection-runtime.ts";
import { logger } from "./logger.ts";
import type { SkillMetadata } from "./types.ts";

export interface VerifiedSkillFile {
  readonly relativeSegments: readonly string[];
  readonly content: Uint8Array;
}

export interface VerifiedSkillBundle {
  readonly metadata: SkillMetadata;
  readonly dirName: string;
  readonly files: readonly VerifiedSkillFile[];
}

export interface SkillDiscoveryResult {
  readonly supported: boolean;
  readonly failed?: boolean;
  readonly skills: readonly VerifiedSkillBundle[];
  readonly rejectedCount: number;
}

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SKILL_NAME_LENGTH = 64;

function validateSkillName(name: string): string | null {
  if (name.length === 0 || name.length > MAX_SKILL_NAME_LENGTH) {
    return null;
  }
  return SKILL_NAME_PATTERN.test(name) ? name : null;
}

function extractSkillRootPrefix(skillFileUri: string): string | null {
  if (!skillFileUri.endsWith("/SKILL.md")) {
    return null;
  }
  return skillFileUri.slice(0, -"SKILL.md".length);
}

function decodeSafeSegment(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const hasUnsafeChar =
    decoded === "" ||
    decoded === "." ||
    decoded === ".." ||
    decoded.includes("/") ||
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.includes(":");
  return hasUnsafeChar ? null : decoded;
}

function hasUnsafeSuffix(suffix: string): boolean {
  return (
    suffix === "" ||
    suffix.includes("?") ||
    suffix.includes("#") ||
    suffix.includes("\\") ||
    suffix.includes("\0")
  );
}

function parseRelativeResourceSegments(
  resourceUri: string,
  rootPrefix: string,
): readonly string[] | null {
  if (!resourceUri.startsWith(rootPrefix)) {
    return null;
  }
  const suffix = resourceUri.slice(rootPrefix.length);
  if (hasUnsafeSuffix(suffix)) {
    return null;
  }
  const segments: string[] = [];
  for (const part of suffix.split("/")) {
    const decoded = decodeSafeSegment(part);
    if (decoded === null) {
      return null;
    }
    segments.push(decoded);
  }
  if (segments.length === 1 && segments[0]?.toLowerCase() === "skill.md") {
    return null;
  }
  return segments;
}

function runTracked<T>(client: Client | ManagedClient, run: () => Promise<T>): Promise<T> {
  return "ownNative" in client ? client.ownNative(run) : run();
}

async function readVerifiedResourceFile(input: {
  skillsClient: SkillsClient;
  client: Client;
  skill: Skill;
  uri: string;
  rootPrefix: string;
  signal: AbortSignal | undefined;
}): Promise<VerifiedSkillFile> {
  const segments = parseRelativeResourceSegments(input.uri, input.rootPrefix);
  if (segments === null) {
    throw new Error(`Unsafe skill resource path: ${input.uri}`);
  }
  const resourceFile = await runTracked(input.client, () =>
    input.skillsClient.read(
      input.skill,
      input.uri,
      input.signal ? { signal: input.signal } : undefined,
    ),
  );
  if (!resourceFile.verified) {
    throw new Error(`Unverified skill resource: ${input.uri}`);
  }
  const content =
    resourceFile.text !== undefined
      ? Buffer.from(resourceFile.text, "utf8")
      : Uint8Array.from(resourceFile.bytes);
  return { relativeSegments: segments, content };
}

async function appendVerifiedResources(input: {
  sdk: SkillsSdkModule;
  skillsClient: SkillsClient;
  client: Client;
  skill: Skill;
  mainUri: string;
  rootPrefix: string;
  files: VerifiedSkillFile[];
  signal: AbortSignal | undefined;
}): Promise<void> {
  const { sdk, skillsClient, client, skill, mainUri, rootPrefix, files, signal } = input;
  if (!Array.isArray(skill.resources)) {
    throw new Error("Dynamic skill resources cannot be cryptographically verified");
  }
  const seenPaths = new Set<string>(["skill.md"]);
  let totalBytes = files[0]?.content.byteLength ?? 0;

  for (const resource of skill.resources) {
    if (resource.uri === mainUri) {
      continue;
    }
    const verified = await readVerifiedResourceFile({
      skillsClient,
      client,
      skill,
      uri: resource.uri,
      rootPrefix,
      signal,
    });
    const normalizedPath = verified.relativeSegments.join("/").toLowerCase();
    if (seenPaths.has(normalizedPath)) {
      throw new Error(`Duplicate skill resource path: ${verified.relativeSegments.join("/")}`);
    }
    seenPaths.add(normalizedPath);
    totalBytes += verified.content.byteLength;
    if (totalBytes > sdk.SKILL_LIMITS.bytes) {
      throw new Error(`Skill exceeds maximum byte size (${sdk.SKILL_LIMITS.bytes})`);
    }
    files.push(verified);
  }
}

async function collectSkillFiles(input: {
  sdk: SkillsSdkModule;
  skillsClient: SkillsClient;
  client: Client;
  skill: Skill;
  signal: AbortSignal | undefined;
}): Promise<readonly VerifiedSkillFile[]> {
  const { sdk, skillsClient, client, skill, signal } = input;
  if (!Array.isArray(skill.resources)) {
    throw new Error("Dynamic skill resources cannot be cryptographically verified");
  }
  if (skill.resources.length > sdk.SKILL_LIMITS.files) {
    throw new Error(`Skill exceeds maximum file count (${sdk.SKILL_LIMITS.files})`);
  }
  const mainFile = await runTracked(client, () =>
    skillsClient.read(skill, undefined, signal ? { signal } : undefined),
  );
  if (!mainFile.verified || typeof mainFile.text !== "string") {
    throw new Error(`Unverified SKILL.md for skill "${skill.frontmatter.name}"`);
  }
  const rootPrefix = extractSkillRootPrefix(mainFile.uri);
  if (rootPrefix === null) {
    throw new Error(`Unexpected SKILL.md URI: ${mainFile.uri}`);
  }
  const files: VerifiedSkillFile[] = [
    { relativeSegments: ["SKILL.md"], content: Buffer.from(mainFile.text, "utf8") },
  ];
  await appendVerifiedResources({
    sdk,
    skillsClient,
    client,
    skill,
    mainUri: mainFile.uri,
    rootPrefix,
    files,
    signal,
  });
  return files;
}

function formatSkillErrorReason(sdk: SkillsSdkModule, error: unknown): string {
  if (error instanceof sdk.SkillVerificationError) {
    return `${error.reason}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function readAndVerifySkillBundle(input: {
  sdk: SkillsSdkModule;
  serverName: string;
  skillsClient: SkillsClient;
  client: Client;
  skill: Skill;
  signal: AbortSignal | undefined;
}): Promise<VerifiedSkillBundle | null> {
  const { sdk, serverName, skillsClient, client, skill, signal } = input;
  const dirName = validateSkillName(skill.frontmatter.name);
  if (dirName === null) {
    logger.warn(
      `MCP: refused skill with unsafe name "${skill.frontmatter.name}" from ${serverName}`,
    );
    return null;
  }
  try {
    const files = await collectSkillFiles({ sdk, skillsClient, client, skill, signal });
    return {
      metadata: {
        name: dirName,
        description: skill.frontmatter.description,
        uri: skill.uri,
      },
      dirName,
      files,
    };
  } catch (error) {
    if (signal?.aborted === true) {
      throw error;
    }
    const reason = formatSkillErrorReason(sdk, error);
    logger.warn(`MCP: refused unverified skill "${dirName}" from ${serverName}: ${reason}`);
    return null;
  }
}

async function verifyListedSkills(input: {
  sdk: SkillsSdkModule;
  serverName: string;
  skillsClient: SkillsClient;
  client: Client;
  listed: SkillListing;
  signal: AbortSignal | undefined;
}): Promise<{ bundles: VerifiedSkillBundle[]; rejectedCount: number }> {
  const { sdk, serverName, skillsClient, client, listed, signal } = input;
  let rejectedCount = listed.invalid.length;
  for (const invalid of listed.invalid) {
    logger.warn(
      `MCP: skipped invalid skill entry ${invalid.uri ?? `#${invalid.index}`} from ${serverName}: ${invalid.reason}`,
    );
  }
  const bundles: VerifiedSkillBundle[] = [];
  const seenNames = new Set<string>();
  for (const skill of listed.skills) {
    const bundle = await readAndVerifySkillBundle({
      sdk,
      serverName,
      skillsClient,
      client,
      skill,
      signal,
    });
    if (bundle === null) {
      rejectedCount += 1;
      continue;
    }
    if (seenNames.has(bundle.dirName)) {
      rejectedCount += 1;
      logger.warn(`MCP: skipped duplicate skill "${bundle.dirName}" from ${serverName}`);
      continue;
    }
    seenNames.add(bundle.dirName);
    bundles.push(bundle);
  }
  return { bundles, rejectedCount };
}

function hasAdvertisedSkillsExtension(client: Client): boolean {
  if (typeof client.getServerCapabilities !== "function") {
    return false;
  }
  const extensions = client.getServerCapabilities()?.extensions;
  return (
    extensions !== undefined &&
    Object.hasOwn(extensions, SKILLS_EXTENSION_ID) &&
    extensions[SKILLS_EXTENSION_ID] !== undefined
  );
}

/**
 * Discovers and cryptographically verifies MCP skills from a connected client.
 * Refuses dynamic, invalid, or verification-failing skills per-skill without breaking
 * valid sibling skills or the server connection.
 */
export async function discoverServerSkills(input: {
  readonly serverName: string;
  readonly client: Client;
  readonly exposeSkills?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<SkillDiscoveryResult> {
  const { serverName, client, exposeSkills, signal } = input;
  if (exposeSkills === false || !hasAdvertisedSkillsExtension(client)) {
    return { supported: false, skills: [], rejectedCount: 0 };
  }
  const sdk = await import("@modelcontextprotocol/client/ext/skills");
  const skillsClient = new sdk.SkillsClient(client, { skipInvalid: true });
  if (!skillsClient.supported) {
    return { supported: false, skills: [], rejectedCount: 0 };
  }
  try {
    const listed = await runTracked(client, () =>
      skillsClient.list(undefined, signal ? { signal } : undefined),
    );
    const verified = await verifyListedSkills({
      sdk,
      serverName,
      skillsClient,
      client,
      listed,
      signal,
    });
    return { supported: true, skills: verified.bundles, rejectedCount: verified.rejectedCount };
  } catch (error) {
    if (signal?.aborted === true) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`MCP: skills/list failed for ${serverName}: ${message}`);
    return { supported: true, failed: true, skills: [], rejectedCount: 1 };
  }
}
