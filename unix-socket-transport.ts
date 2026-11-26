import { createConnection, type Socket } from "node:net";
import {
  ReadBuffer,
  serializeMessage,
  type Transport,
  type JSONRPCMessage,
} from "@modelcontextprotocol/client";

/** MCP JSONL transport for an explicitly configured Unix-domain socket. */
export class UnixSocketClientTransport implements Transport {
  private socket: Socket | undefined;
  private readonly readBuffer = new ReadBuffer();

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private readonly socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  async start(): Promise<void> {
    if (this.socket) {
      throw new Error("UnixSocketClientTransport already started");
    }

    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      this.socket = socket;
      let settled = false;

      socket.once("connect", () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      socket.on("data", (chunk) => this.handleData(chunk));
      socket.on("error", (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
        this.onerror?.(error);
      });
      socket.on("close", () => {
        if (this.socket === socket) {
          this.socket = undefined;
        }
        this.readBuffer.clear();
        if (!settled) {
          settled = true;
          reject(new Error("UnixSocketClientTransport closed before connecting"));
        }
        this.onclose?.();
      });
    });
  }

  private handleData(chunk: Buffer): void {
    try {
      this.readBuffer.append(chunk);
      while (true) {
        const message = this.readBuffer.readMessage();
        if (message === null) {
          break;
        }
        this.onmessage?.(message);
      }
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      this.onerror?.(cause);
      this.close().catch((closeError: unknown) => {
        this.onerror?.(closeError instanceof Error ? closeError : new Error(String(closeError)));
      });
    }
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    this.readBuffer.clear();
    if (!socket || socket.destroyed) {
      return;
    }
    if (socket.connecting) {
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.destroy();
      });
      return;
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => socket.destroy(), 2_000);
      timeout.unref();
      socket.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.end();
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      throw new Error("Unix socket is not connected");
    }

    await new Promise<void>((resolve, reject) => {
      socket.write(serializeMessage(message), (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}
