# Interactive Visualizer Example

A minimal MCP server example for `@fitchmultz/pi-mcp-adapter` that demonstrates:

1. **Charts** — Renders bar, line, pie, and doughnut charts via Chart.js
2. **Bidirectional communication** — Send messages from the UI back to the agent
3. **Streaming** — Datasets arrive progressively, chart builds live

## Install locally

```bash
cd examples/interactive-visualizer
npm install
npm run build
npm run install-local
```

The helper writes only `<Pi agent dir>/fitch-mcp-adapter/mcp.json` (`~/.pi/agent/fitch-mcp-adapter/mcp.json` by default, honoring `PI_CODING_AGENT_DIR`). Restart Pi; `show_chart` will be available via the MCP proxy.

## Usage

Ask the agent to show a chart:

> Show me a bar chart of quarterly revenue: Q1 $180k, Q2 $220k, Q3 $265k, Q4 $305k

The agent calls `show_chart`, the UI opens in Glimpse (macOS) or the browser, and the chart renders. Type a message in the input field and click "Send" to communicate back to the agent.

## Uninstall

```bash
npm run uninstall-local
```
