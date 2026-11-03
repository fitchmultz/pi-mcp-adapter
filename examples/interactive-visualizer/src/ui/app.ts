import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
import Chart, { type ChartType } from "chart.js/auto";
import {
  UI_STREAM_RESULT_PATCH_METHOD,
  uiStreamResultPatchNotificationSchema,
} from "../../../../ui-stream-types.ts";
import { extractContent, parseChartInput, type ChartSpec } from "./chart-content.ts";

const app = new App({ name: "interactive-visualizer", version: "0.1.0" });
const root = getAppRoot();

let chartInstance: Chart<ChartType, unknown> | null = null;

function getAppRoot(): HTMLElement {
  const element = document.getElementById("app");
  if (element === null) {
    throw new Error("The interactive visualizer requires an #app element");
  }
  return element;
}

function nonEmptyText(value: string | undefined, fallback: string): string {
  return value === undefined || value.length === 0 ? fallback : value;
}

function renderChart(spec: ChartSpec) {
  root.innerHTML = "";

  const header = document.createElement("h2");
  header.textContent = nonEmptyText(spec.title, "Chart");
  root.appendChild(header);

  const canvas = document.createElement("canvas");
  canvas.style.maxHeight = "400px";
  root.appendChild(canvas);

  chartInstance?.destroy();
  chartInstance = new Chart<ChartType, unknown>(canvas, {
    type: spec.type,
    data: {
      labels: spec.labels,
      datasets: spec.datasets.map((ds) => ({
        label: ds.label,
        data: ds.data,
        backgroundColor: ds.color === "" ? undefined : ds.color,
        borderColor: ds.color === "" ? undefined : ds.color,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
    },
  });

  appendMessageForm();
}

function renderSvg(svg: string) {
  root.innerHTML = "";
  const container = document.createElement("div");
  container.className = "svg-container";
  container.innerHTML = svg;
  root.appendChild(container);

  // Wire up clickable choice nodes
  container.addEventListener("click", (e) => {
    if (!(e.target instanceof Element)) {
      return;
    }
    const target = e.target.closest("[data-choice]");
    if (!target) {
      return;
    }
    const choice = target.getAttribute("data-choice");
    if (choice === null || choice.length === 0) {
      return;
    }
    const label = nonEmptyText(target.textContent.trim(), choice);
    app
      .sendMessage({ role: "user", content: [{ type: "text", text: `Chose: ${label}` }] })
      .catch(() => {
        // Choices are best-effort; the message form remains available if the host rejects one.
      });
  });

  appendMessageForm();
}

function appendMessageForm() {
  const form = document.createElement("form");
  form.className = "message-form";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Send a message to the agent...";
  const button = document.createElement("button");
  button.type = "submit";
  button.textContent = "Send";
  form.append(input, button);
  root.appendChild(form);

  const status = document.createElement("div");
  status.className = "status";
  root.appendChild(status);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (text.length === 0) {
      return;
    }
    input.value = "";
    status.textContent = "Sending...";
    app
      .sendMessage({ role: "user", content: [{ type: "text", text }] })
      .then(() => {
        status.textContent = "Sent!";
        setTimeout(() => {
          status.textContent = "";
        }, 2000);
      })
      .catch((err: unknown) => {
        status.textContent = `Failed: ${err instanceof Error ? err.message : String(err)}`;
      });
  });
}

function renderContent(content: ReturnType<typeof extractContent>) {
  if (!content) {
    return;
  }
  if (content.type === "svg") {
    renderSvg(content.svg);
  } else {
    renderChart(content.chart);
  }
}

app.setNotificationHandler(
  UI_STREAM_RESULT_PATCH_METHOD,
  { params: uiStreamResultPatchNotificationSchema.shape.params },
  (params) => {
    renderContent(extractContent(params));
  },
);

app.addEventListener("toolresult", (result) => {
  renderContent(extractContent(result));
});

app.addEventListener("toolinput", ({ arguments: args }) => {
  if (!args) {
    return;
  }
  try {
    const chart = parseChartInput(args);
    if (chart) {
      renderChart(chart);
    }
  } catch (err) {
    root.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
});

app.connect(new PostMessageTransport(window.parent, window.parent)).catch((err: unknown) => {
  root.textContent = `Connection failed: ${err instanceof Error ? err.message : String(err)}`;
});
