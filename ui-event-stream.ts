import type { ServerResponse } from "node:http";
import { getVisualizationStreamEnvelope } from "./ui-stream-types.ts";
import type { UiHostContext, UiStreamSummary } from "./types.ts";
import { isUiJsonObject } from "./ui-json.ts";

const MAX_EVENT_LOG = 128;
interface UiEvent {
  id: number;
  name: string;
  payload: unknown;
}

function streamEnvelope(payload: unknown): ReturnType<typeof getVisualizationStreamEnvelope> {
  return getVisualizationStreamEnvelope(
    isUiJsonObject(payload) ? payload.structuredContent : undefined,
  );
}

function serializeEvent(entry: UiEvent): string {
  return `id: ${entry.id}\nevent: ${entry.name}\ndata: ${JSON.stringify(entry.payload)}\n\n`;
}

/** Ordered SSE delivery, replay checkpoints and stream summaries share one event log. */
export class UiEventStream {
  private readonly clients = new Set<ServerResponse>();
  private readonly eventLog: UiEvent[] = [];
  private nextId = 1;
  private summary: UiStreamSummary | undefined;

  constructor(hostContext: UiHostContext) {
    const initial = hostContext["pi-mcp-adapter/stream"];
    if (
      isUiJsonObject(initial) &&
      typeof initial.streamId === "string" &&
      (initial.mode === "eager" || initial.mode === "stream-first")
    ) {
      this.summary = { streamId: initial.streamId, mode: initial.mode, frames: 0, phases: [] };
    }
  }

  push(name: string, payload: unknown): void {
    const entry = { id: this.nextId++, name, payload };
    this.eventLog.push(entry);
    this.updateSummary(payload);
    this.prune();
    const chunk = serializeEvent(entry);
    for (const client of this.clients) {
      try {
        client.write(chunk);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  connect(res: ServerResponse, lastEventId: string | undefined): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    this.clients.add(res);
    const parsedLastId =
      lastEventId !== undefined && lastEventId !== "" ? Number(lastEventId) : Number.NaN;
    const checkpoint = this.latestCheckpointIndex();
    const entries = Number.isFinite(parsedLastId)
      ? this.eventLog.filter((entry) => entry.id > parsedLastId)
      : this.eventLog.slice(Math.max(0, checkpoint));
    for (const entry of entries) {
      if (!this.writeReplay(res, entry)) {
        return;
      }
    }
  }

  disconnect(res: ServerResponse): void {
    this.clients.delete(res);
  }

  close(): void {
    for (const client of this.clients) {
      try {
        client.end();
      } catch {
        // A disconnected SSE peer cannot receive further completion bytes.
      }
    }
    this.clients.clear();
  }

  getSummary(): UiStreamSummary | undefined {
    return this.summary ? { ...this.summary, phases: [...this.summary.phases] } : undefined;
  }

  private writeReplay(res: ServerResponse, entry: UiEvent): boolean {
    try {
      res.write(serializeEvent(entry));
      return true;
    } catch {
      this.clients.delete(res);
      return false;
    }
  }

  private latestCheckpointIndex(): number {
    for (let index = this.eventLog.length - 1; index >= 0; index -= 1) {
      const entry = this.eventLog[index];
      if (!entry) {
        continue;
      }
      const envelope = streamEnvelope(entry.payload);
      if (envelope?.frameType === "checkpoint" || envelope?.frameType === "final") {
        return index;
      }
    }
    return -1;
  }

  private prune(): void {
    if (this.eventLog.length <= MAX_EVENT_LOG) {
      return;
    }
    const checkpoint = this.latestCheckpointIndex();
    if (checkpoint > 0) {
      this.eventLog.splice(0, checkpoint);
    }
    if (this.eventLog.length > MAX_EVENT_LOG) {
      this.eventLog.splice(0, this.eventLog.length - MAX_EVENT_LOG);
    }
  }

  private updateSummary(payload: unknown): void {
    const envelope = streamEnvelope(payload);
    if (!envelope) {
      return;
    }
    this.summary ??= { streamId: envelope.streamId, mode: "eager", frames: 0, phases: [] };
    this.summary.frames += 1;
    if (!this.summary.phases.includes(envelope.phase)) {
      this.summary.phases.push(envelope.phase);
    }
    this.summary.finalStatus = envelope.status;
    if (envelope.message !== undefined) {
      this.summary.lastMessage = envelope.message;
    } else {
      delete this.summary.lastMessage;
    }
  }
}
