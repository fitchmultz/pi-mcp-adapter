import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  SERVER_STREAM_RESULT_PATCH_METHOD,
  UI_STREAM_REQUEST_META_KEY,
  UI_STREAM_STRUCTURED_CONTENT_KEY,
  type ServerStreamResultPatchNotification,
} from "../../../ui-stream-types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appHtml = readFileSync(join(__dirname, "..", "dist", "app.html"), "utf-8");

const server = new McpServer({
  name: "interactive-visualizer",
  version: "0.1.0",
});

function readStreamToken(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

server.registerResource(
  "app-html",
  new ResourceTemplate("ui://interactive-visualizer/app.html", { list: undefined }),
  { mimeType: "text/html;profile=mcp-app" },
  () => ({
    contents: [
      {
        uri: "ui://interactive-visualizer/app.html",
        mimeType: "text/html;profile=mcp-app",
        text: appHtml,
      },
    ],
  }),
);

async function sendStreamFrame(
  streamToken: string,
  sendNotification: (notification: ServerStreamResultPatchNotification) => Promise<void>,
  frame: ServerStreamResultPatchNotification["params"]["result"],
): Promise<void> {
  try {
    await sendNotification({
      method: SERVER_STREAM_RESULT_PATCH_METHOD,
      params: { streamToken, result: frame },
    });
  } catch {
    // Streaming is best-effort; the tool's final result still carries the complete visualization.
  }
}

// --- Chart tool ---

server.registerTool(
  "show_chart",
  {
    description: "Display an interactive chart. The chart opens in a UI window.",
    inputSchema: z.object({
      type: z.string().describe("Chart type: bar, line, pie, or doughnut"),
      title: z.string().describe("Chart title"),
      labels: z.string().describe("Comma-separated labels for the x-axis or segments"),
      datasets: z.string().describe("JSON array of datasets: [{label, data: number[], color?}]"),
    }),
    _meta: { ui: { resourceUri: "ui://interactive-visualizer/app.html" } },
  },
  async (args, extra) => {
    const datasets: unknown = JSON.parse(args.datasets.length === 0 ? "[]" : args.datasets);
    const spec = {
      type: args.type.length === 0 ? "bar" : args.type,
      title: args.title.length === 0 ? "Chart" : args.title,
      labels: args.labels.split(",").map((s) => s.trim()),
      datasets,
    };

    const streamToken = readStreamToken(extra.mcpReq._meta?.[UI_STREAM_REQUEST_META_KEY]);
    if (streamToken !== undefined && Array.isArray(datasets)) {
      const sendAdapterNotification = (notification: ServerStreamResultPatchNotification) =>
        extra.mcpReq.notify(notification);
      for (let i = 0; i < datasets.length; i++) {
        const partial = { ...spec, datasets: datasets.slice(0, i + 1) };
        const isLast = i === datasets.length - 1;
        await sendStreamFrame(streamToken, sendAdapterNotification, {
          content: [{ type: "text", text: `Dataset ${i + 1}/${datasets.length}` }],
          structuredContent: {
            [UI_STREAM_STRUCTURED_CONTENT_KEY]: {
              frameType: isLast ? "final" : "patch",
              phase: isLast ? "settled" : "structure",
              status: "ok",
            },
            chart: partial,
          },
        });
      }
    }

    return {
      content: [{ type: "text", text: `Rendered ${spec.type} chart: ${spec.title}` }],
      structuredContent: { chart: spec },
    };
  },
);

// --- Adventure tree tool ---

interface StoryNode {
  id: string;
  text: string;
  tier: number;
  col: number;
  choice?: boolean;
  parentId?: string;
}

const STORY: StoryNode[][] = [
  [{ id: "start", text: "You find a locked door", tier: 0, col: 1 }],
  [
    { id: "pick", text: "Pick the lock", tier: 1, col: 0, choice: true, parentId: "start" },
    { id: "kick", text: "Kick it down", tier: 1, col: 2, choice: true, parentId: "start" },
  ],
  [
    { id: "hall", text: "A quiet hallway", tier: 2, col: 0, parentId: "pick" },
    { id: "alarm", text: "Alarm triggers!", tier: 2, col: 2, parentId: "kick" },
  ],
  [
    { id: "left", text: "Go left", tier: 3, col: 0, choice: true, parentId: "hall" },
    { id: "right", text: "Go right", tier: 3, col: 1, choice: true, parentId: "hall" },
    { id: "run", text: "Run!", tier: 3, col: 2, choice: true, parentId: "alarm" },
  ],
  [
    { id: "lab", text: "Secret lab", tier: 4, col: 0, parentId: "left" },
    { id: "vault", text: "The vault", tier: 4, col: 1, parentId: "right" },
    { id: "roof", text: "Reach the roof", tier: 4, col: 2, parentId: "run" },
  ],
  [
    { id: "serum", text: "Take the serum", tier: 5, col: 0, choice: true, parentId: "lab" },
    { id: "notes", text: "Read the notes", tier: 5, col: 0, choice: true, parentId: "lab" },
    { id: "gold", text: "Grab the gold", tier: 5, col: 1, choice: true, parentId: "vault" },
    { id: "map", text: "Take the map", tier: 5, col: 1, choice: true, parentId: "vault" },
    { id: "jump", text: "Jump!", tier: 5, col: 2, choice: true, parentId: "roof" },
    { id: "hide", text: "Hide", tier: 5, col: 2, choice: true, parentId: "roof" },
  ],
];

function renderStoryNode(node: StoryNode, x: number, y: number): string {
  const nodeW = 140;
  const nodeH = 36;
  const choice = node.choice === true;
  const fill = choice ? "#1a3a4a" : "#1a2030";
  const stroke = choice ? "#4a9ead" : "#2a3a4a";
  const textFill = choice ? "#7ad4e4" : "#8a9aaa";
  const choiceAttr = choice ? ` data-choice="${node.id}" style="cursor:pointer"` : "";
  return (
    `<rect x="${x - nodeW / 2}" y="${y}" width="${nodeW}" height="${nodeH}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="1.5"${choiceAttr}/>` +
    `<text x="${x}" y="${y + nodeH / 2 + 4}" fill="${textFill}" font-family="system-ui, sans-serif" font-size="12" font-weight="${choice ? 600 : 400}" text-anchor="middle"${choiceAttr}>${node.text}</text>`
  );
}

function buildAdventureFrame(tiers: number): string {
  const W = 720;
  const tierH = 90;
  const nodeH = 36;
  const H = 60 + tiers * tierH;

  const allNodes: StoryNode[] = [];
  for (let t = 0; t < tiers && t < STORY.length; t++) {
    allNodes.push(...(STORY[t] ?? []));
  }
  const byId = new Map(allNodes.map((n) => [n.id, n]));

  const colX = (col: number) => 120 + col * ((W - 240) / 2);
  const nodeX = (n: StoryNode) => colX(n.col);
  const nodeY = (n: StoryNode) => 40 + n.tier * tierH;

  let svg = "";

  for (const node of allNodes) {
    if (node.parentId === undefined || node.parentId.length === 0) {
      continue;
    }
    const parent = byId.get(node.parentId);
    if (!parent) {
      continue;
    }
    const x1 = nodeX(parent),
      y1 = nodeY(parent) + nodeH;
    const x2 = nodeX(node),
      y2 = nodeY(node);
    const my = (y1 + y2) / 2;
    svg += `<path d="M${x1} ${y1} C${x1} ${my} ${x2} ${my} ${x2} ${y2}" fill="none" stroke="#3a4a5c" stroke-width="1.5"/>`;
  }

  for (const node of allNodes) {
    svg += renderStoryNode(node, nodeX(node), nodeY(node));
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" rx="12" fill="#0d1117"/>${svg}</svg>`;
}

server.registerTool(
  "stream_adventure",
  {
    description:
      "Stream an interactive choose-your-own-adventure decision tree. The story builds tier by tier. Click any choice node to send your decision back to the agent.",
    inputSchema: z.object({}),
    _meta: { ui: { resourceUri: "ui://interactive-visualizer/app.html" } },
  },
  async (_args, extra) => {
    const streamToken = readStreamToken(extra.mcpReq._meta?.[UI_STREAM_REQUEST_META_KEY]);

    if (streamToken !== undefined) {
      const sendAdapterNotification = (notification: ServerStreamResultPatchNotification) =>
        extra.mcpReq.notify(notification);
      for (let t = 1; t <= STORY.length; t++) {
        const isLast = t === STORY.length;
        await sendStreamFrame(streamToken, sendAdapterNotification, {
          content: [{ type: "text", text: `Tier ${t}/${STORY.length}` }],
          structuredContent: {
            [UI_STREAM_STRUCTURED_CONTENT_KEY]: {
              frameType: isLast ? "final" : "patch",
              phase: isLast ? "settled" : "structure",
              status: "ok",
            },
            svg: buildAdventureFrame(t),
          },
        });
      }
    }

    return {
      content: [
        {
          type: "text",
          text: "Adventure tree complete. Click a choice to tell the agent your decision.",
        },
      ],
      structuredContent: { svg: buildAdventureFrame(STORY.length) },
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
