import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createMcpAdapter } from "@fitchmultz/pi-mcp-adapter";
import {
  ModelRuntime,
  SettingsManager,
  SessionManager,
  DefaultResourceLoader,
  createAgentSession,
  createCodemodeExtension,
  createToolSearchExtension,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { fixtureProvider, fixtureStream, type FixtureModel, type FixtureCall } from "./model.ts";
import { nativeProbe } from "./policy.ts";
import { WireFixture } from "./wire.ts";

interface SessionOptions {
  manager?: SessionManager;
  directTools?: boolean | string[];
  disabled?: boolean;
  tools?: string[];
  eager?: boolean;
}

export class NativeSession {
  readonly session: AgentSession;
  private readonly model: FixtureModel;

  constructor(session: AgentSession, model: FixtureModel) {
    this.session = session;
    this.model = model;
  }

  async run(name: string, args: FixtureCall["arguments"]): Promise<ToolResultMessage> {
    let issued = false;
    const before = this.session.messages.length;
    this.session.agent.streamFunction = () => {
      const call = issued ? undefined : { name, arguments: args };
      issued = true;
      return fixtureStream(this.model, call, `outer-${before}`);
    };
    await this.session.prompt("Exercise native local composition.");
    const toolResult = this.session.messages
      .slice(before)
      .find((message) => message.role === "toolResult");
    assert.ok(toolResult, `run(${name}) must produce a tool result`);
    return toolResult;
  }

  async close(): Promise<void> {
    await this.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    this.session.dispose();
  }
}

export class NativeFixture {
  readonly root: string;
  readonly agentDir: string;
  readonly captured: string;
  readonly url: string;
  readonly wire: WireFixture;
  private readonly modelRuntime: ModelRuntime;
  private readonly model: FixtureModel;
  private readonly sessions = new Set<NativeSession>();

  private constructor(root: string, wire: WireFixture, modelRuntime: ModelRuntime, url: string) {
    this.root = root;
    this.agentDir = join(root, "agent");
    this.captured = join(root, "capture.jsonl");
    this.wire = wire;
    this.modelRuntime = modelRuntime;
    this.url = url;
    const model = modelRuntime.getModel("fixture", "fixture");
    assert.ok(model, "native fixture provider must register its model");
    this.model = model;
  }

  static async create(root: string): Promise<NativeFixture> {
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    const wire = new WireFixture();
    const url = await wire.listen();
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
    });
    modelRuntime.registerProvider("fixture", fixtureProvider(url));
    return new NativeFixture(root, wire, modelRuntime, url);
  }

  async make({
    manager = SessionManager.inMemory(this.root),
    directTools = false,
    disabled = false,
    tools,
    eager = false,
  }: SessionOptions = {}): Promise<NativeSession> {
    const settingsManager = SettingsManager.inMemory();
    const adapter = createMcpAdapter({
      config: {
        mcpServers: {
          local: {
            url: this.url,
            auth: false,
            directTools,
            disabled,
            lifecycle: eager ? "eager" : "lazy",
          },
        },
        settings: { sampling: false, elicitation: false },
      },
      outputDirectory: join(this.root, "output"),
      onToolCall: async (event) => {
        appendFileSync(
          this.captured,
          JSON.stringify({
            phase: event.phase,
            toolCallId: event.toolCallId,
            args: event.args,
            ...(event.phase === "after" && "result" in event ? { result: event.result } : {}),
            ...(event.phase === "after" && "error" in event ? { error: String(event.error) } : {}),
          }) + "\n",
          { mode: 0o600 },
        );
      },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.root,
      agentDir: this.agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        adapter,
        nativeProbe,
        createCodemodeExtension({ models: false }),
        createToolSearchExtension(),
      ],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const { session } = await createAgentSession({
      cwd: this.root,
      agentDir: this.agentDir,
      settingsManager,
      resourceLoader,
      modelRuntime: this.modelRuntime,
      model: this.model,
      sessionManager: manager,
      noTools: "builtin",
      ...(tools === undefined ? {} : { tools }),
    });
    const native = new NativeSession(session, this.model);
    this.sessions.add(native);
    await session.bindExtensions({
      mode: "print",
      onError(error) {
        throw new Error(error.error);
      },
    });
    return native;
  }

  async release(session: NativeSession): Promise<void> {
    await session.close();
    this.sessions.delete(session);
  }

  async close(): Promise<void> {
    for (const session of this.sessions) {
      await this.release(session);
    }
    await this.wire.close();
  }
}
