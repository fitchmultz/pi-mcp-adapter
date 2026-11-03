import assert from "node:assert/strict";
import http from "node:http";

export async function request(
  url: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: unknown; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: options.method ?? "GET",
        headers: { "Content-Type": "application/json", ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: unknown) => {
          assert(Buffer.isBuffer(chunk));
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

export function connectSSE(
  url: string,
  onEvent: (name: string, data: unknown, eventId?: string) => void,
  headers: Record<string, string> = {},
): Promise<{ close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { Accept: "text/event-stream", ...headers } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`SSE connection failed: ${String(res.statusCode)}`));
        return;
      }
      res.setEncoding("utf8");
      let buffer = "";
      let eventName = "message";
      let eventId: string | undefined;
      res.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("id: ")) {
            eventId = line.slice(4);
          } else if (line.startsWith("event: ")) {
            eventName = line.slice(7);
          } else if (line.startsWith("data: ")) {
            let data: unknown;
            try {
              data = JSON.parse(line.slice(6));
            } catch {
              data = line.slice(6);
            }
            onEvent(eventName, data, eventId);
            eventName = "message";
            eventId = undefined;
          }
        }
      });
      resolve({ close: () => req.destroy() });
    });
    req.on("error", reject);
  });
}
