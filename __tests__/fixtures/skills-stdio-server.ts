import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import {
  SkillsExtension,
  memorySkillFiles,
  skillEntry,
  type Skill,
  type SkillReadResult,
} from "@modelcontextprotocol/server/ext/skills";
import { z } from "zod";

const mode = process.argv[2] ?? "valid";
const mcp = new McpServer({ name: `skills-${mode}`, version: "1.0.0" });

mcp.registerTool(
  "ping",
  {
    description: "Health ping tool",
    inputSchema: z.object({}),
  },
  async () => ({ content: [{ type: "text" as const, text: `pong:${mode}` }] }),
);

async function attachSkillsExtension(server: McpServer, selectedMode: string): Promise<void> {
  if (selectedMode === "no-skills") {
    return;
  }
  if (selectedMode === "valid") {
    const catalog = await SkillsExtension.load(
      memorySkillFiles({
        "alpha-skill/SKILL.md":
          "---\nname: alpha-skill\ndescription: Alpha verified skill.\n---\nRead references/guide.md.\n",
        "alpha-skill/references/guide.md": "# Alpha Guide\nUse verified skills.\n",
        "beta-skill/SKILL.md":
          "---\nname: beta-skill\ndescription: Beta verified skill.\n---\nBeta steps.\n",
      }),
    );
    catalog.attach(server);
    return;
  }
  if (selectedMode === "updated") {
    const catalog = await SkillsExtension.load(
      memorySkillFiles({
        "gamma-skill/SKILL.md":
          "---\nname: gamma-skill\ndescription: Gamma updated skill.\n---\nGamma steps.\n",
      }),
    );
    catalog.attach(server);
    return;
  }
  const mixed = await buildMixedSkillsExtension();
  mixed.attach(server);
}

interface MixedSkillsData {
  readonly validSkill: Skill;
  readonly validMain: string;
  readonly validNote: string;
  readonly tamperedSkill: Skill;
  readonly badResSkill: Skill;
  readonly badResMain: string;
  readonly escapeSkill: Skill;
}

async function buildMixedSkillsExtension(): Promise<SkillsExtension> {
  const validMain =
    "---\nname: valid-skill\ndescription: Valid skill.\n---\nRead references/note.md.\n";
  const validNote = "verified reference note\n";
  const validSkill = await skillEntry("valid-skill", {
    "SKILL.md": validMain,
    "references/note.md": validNote,
  });

  const dynamicSkill: Skill = {
    ...(await skillEntry("dynamic-skill", {
      "SKILL.md": "---\nname: dynamic-skill\ndescription: Dynamic skill.\n---\nDynamic\n",
    })),
    resources: "dynamic",
  };

  const tamperedSkill = await skillEntry("tampered-skill", {
    "SKILL.md": "---\nname: tampered-skill\ndescription: Tampered skill.\n---\nOriginal text\n",
  });

  const badResMain =
    "---\nname: bad-resource-skill\ndescription: Bad resource digest.\n---\nRead ref.\n";
  const badResSkill = await skillEntry("bad-resource-skill", {
    "SKILL.md": badResMain,
    "references/extra.md": "original resource text\n",
  });

  const escapeBase = await skillEntry("escape-skill", {
    "SKILL.md": "---\nname: escape-skill\ndescription: Escape name.\n---\nEscape\n",
  });
  const escapeSkill: Skill = {
    ...escapeBase,
    frontmatter: { ...escapeBase.frontmatter, name: "../escape-skill" },
  };

  const allSkills: Skill[] = [validSkill, dynamicSkill, tamperedSkill, badResSkill, escapeSkill];
  const skillsByUri = new Map<string, Skill>(allSkills.map((entry) => [entry.uri, entry]));
  const filesByUri = buildMixedFileMap({
    validSkill,
    validMain,
    validNote,
    tamperedSkill,
    badResSkill,
    badResMain,
    escapeSkill,
  });

  return new SkillsExtension({
    source: {
      list: async () => ({ skills: allSkills }),
      get: async (uri) => skillsByUri.get(uri),
      read: async (uri) => filesByUri.get(uri),
    },
  });
}

function findResourceUri(skill: Skill, suffix: string): string | undefined {
  if (!Array.isArray(skill.resources)) {
    return undefined;
  }
  return skill.resources.find((entry) => entry.uri.endsWith(suffix))?.uri;
}

function buildMixedFileMap(input: MixedSkillsData): Map<string, SkillReadResult> {
  const validNoteUri = findResourceUri(input.validSkill, "references/note.md");
  const badResChildUri = findResourceUri(input.badResSkill, "references/extra.md");
  const files = new Map<string, SkillReadResult>([
    [input.validSkill.uri, { text: input.validMain, mimeType: "text/markdown" }],
    [
      input.tamperedSkill.uri,
      {
        text: "---\nname: tampered-skill\ndescription: Tampered skill.\n---\nTAMPERED\n",
        mimeType: "text/markdown",
      },
    ],
    [input.badResSkill.uri, { text: input.badResMain, mimeType: "text/markdown" }],
    [
      input.escapeSkill.uri,
      {
        text: "---\nname: ../escape-skill\ndescription: Escape name.\n---\nEscape\n",
        mimeType: "text/markdown",
      },
    ],
  ]);
  if (validNoteUri !== undefined) {
    files.set(validNoteUri, { text: input.validNote, mimeType: "text/markdown" });
  }
  if (badResChildUri !== undefined) {
    files.set(badResChildUri, { text: "TAMPERED RESOURCE", mimeType: "text/markdown" });
  }
  return files;
}

await attachSkillsExtension(mcp, mode);
await mcp.connect(new StdioServerTransport());
