import { z } from "zod";

// The built-in controllers registered by chart.js/auto.
const chartTypeSchema = z.enum([
  "bar",
  "line",
  "pie",
  "doughnut",
  "scatter",
  "bubble",
  "radar",
  "polarArea",
]);

const chartSpecSchema = z.object({
  type: chartTypeSchema,
  title: z.string().optional(),
  labels: z.array(z.string()),
  datasets: z.array(
    z.object({
      label: z.string().optional(),
      // Chart.js owns the data-point formats for each controller.
      data: z.unknown().optional(),
      color: z.string().optional(),
    }),
  ),
});
export type ChartSpec = z.infer<typeof chartSpecSchema>;

const structuredContentSchema = z.object({
  svg: z.string().optional(),
  chart: z.unknown().optional(),
});

type Visualization = { type: "svg"; svg: string } | { type: "chart"; chart: ChartSpec };

export function extractContent(data: Record<string, unknown>): Visualization | undefined {
  const parsed = structuredContentSchema.safeParse(data.structuredContent);
  if (!parsed.success) {
    return undefined;
  }
  const { svg, chart } = parsed.data;
  if (svg !== undefined && svg.length > 0) {
    return { type: "svg", svg };
  }
  const parsedChart = chartSpecSchema.safeParse(chart);
  return parsedChart.success ? { type: "chart", chart: parsedChart.data } : undefined;
}

export function parseChartInput(args: Record<string, unknown>): ChartSpec | undefined {
  if (
    typeof args.type !== "string" ||
    args.type.length === 0 ||
    args.labels === undefined ||
    args.datasets === undefined ||
    args.labels === "" ||
    args.datasets === ""
  ) {
    return undefined;
  }
  const labels =
    typeof args.labels === "string"
      ? args.labels.split(",").map((label) => label.trim())
      : args.labels;
  const datasets: unknown =
    typeof args.datasets === "string"
      ? JSON.parse(args.datasets.length === 0 ? "[]" : args.datasets)
      : args.datasets;
  return chartSpecSchema.parse({ ...args, labels, datasets });
}
