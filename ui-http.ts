import type { IncomingMessage, ServerResponse } from "node:http";
import type { UiProxyResult } from "./types.ts";
import { isUiJsonObject } from "./ui-json.ts";

const MAX_BODY_SIZE = 2 * 1024 * 1024;

export function sendJson<T>(res: ServerResponse, status: number, payload: UiProxyResult<T>): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

export function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

export function validateTokenQuery(
  url: URL,
  expected: string,
  res: ServerResponse,
  parameter = "session",
): boolean {
  if (url.searchParams.get(parameter) !== expected) {
    sendJson(res, 403, { ok: false, error: "Invalid session" });
    return false;
  }
  return true;
}

export function requestUrl(req: IncomingMessage): URL {
  const host = req.headers.host;
  const pathname = req.url === undefined || req.url === "" ? "/" : req.url;
  const hostname = host === undefined || host === "" ? "127.0.0.1" : host;
  return new URL(pathname, `http://${hostname}`);
}

export interface UiHttpBody {
  token: unknown;
  params: unknown;
}

export async function parseBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<UiHttpBody | null> {
  try {
    const body = await readBody(req);
    if (!isUiJsonObject(body)) {
      sendJson(res, 400, { ok: false, error: "Invalid request body" });
      return null;
    }
    return { token: body.token, params: body.params ?? {} };
  } catch (error) {
    sendJson(res, 400, {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid body",
    });
    return null;
  }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: unknown) => {
      if (!Buffer.isBuffer(chunk)) {
        req.destroy();
        reject(new Error("Invalid request body chunk"));
        return;
      }
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        resolve(body);
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}
