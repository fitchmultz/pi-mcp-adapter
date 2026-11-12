import { JSDOM } from "jsdom";
import { z } from "zod";

export function hostConfiguration(html: string): {
  sessionToken: string;
  uiResourceToken: string;
  requireToolConsent: boolean;
  allowAttribute: string;
  toolArgs: Record<string, unknown>;
  toolInputEventId?: number | undefined;
  hostContext: unknown;
} {
  const dom = new JSDOM(html);
  try {
    const text = dom.window.document.getElementById("host-configuration")?.textContent;
    if (text === undefined) {
      throw new Error("Missing host configuration");
    }
    const value: unknown = JSON.parse(text);
    return z
      .object({
        sessionToken: z.string(),
        uiResourceToken: z.string(),
        requireToolConsent: z.boolean(),
        allowAttribute: z.string(),
        toolArgs: z.record(z.string(), z.unknown()),
        toolInputEventId: z.number().int().positive().optional(),
        hostContext: z.unknown(),
      })
      .parse(value);
  } finally {
    dom.window.close();
  }
}
