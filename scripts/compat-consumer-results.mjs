import { z } from "zod";

const packSchema = z.object({ filename: z.string() });
export const packResultSchema = z.union([z.array(packSchema), z.record(z.string(), packSchema)]);

export const cliObservationSchema = z.object({
  version: z.string(),
  packageDir: z.string(),
  tools: z.array(z.string()),
  activeTools: z.array(z.string()),
  commands: z.array(z.string()),
});

/** @typedef {z.infer<typeof cliObservationSchema>} CliObservation */
