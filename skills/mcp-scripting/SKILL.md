---
name: mcp-scripting
description: Write mcp_script JavaScript for discovering, inspecting, and calling MCP tools, resources, and saved results.
---

# MCP scripting

Use `mcp_script` for MCP calls with loops, filtering, chaining, fan-out, or other logic between calls. Pass ordinary JavaScript as its `code` argument. For a single call, use an already loaded typed tool. Use `mcp_search({ query, server?, limit?, offset? })` to discover and load typed tools for the next request, or explicit `mcp` actions for gateway-only workflows. Discovery never executes a search hit.

## Discover, inspect, then call

```js
const found = await tools.search({ query: "search issues", server: "github" });
if (found.error) return found;
emit(found.coverage);
for (const item of found.items) {
  emit(await tools.describe({ path: item.path, server: item.server }));
}
```

Read the returned descriptors and choose the tool that matches the task. Do not call the first ranked hit without checking its identity and schema. In a subsequent script, use its exact returned path and schema-correct arguments:

```js
const results = [];
for (const query of ["is:open label:bug", "is:open label:docs"]) {
  const result = await tools.call("github_search_issues", { query });
  if (!result.ok) return result;
  results.push({ query, data: result.data });
}
return results;
```

## API and return shapes

- `await tools.search({ query, server?, limit?, offset? })` returns `{ items, total, hasMore, nextOffset, coverage }`. Items carry `path`, `name`, `server`, optional `description`, and `score`. Discovery failures return `{ error, coverage }`. Script search defaults to **12** items, maximum **100**, with zero-based item offsets. The separate `mcp_search` loader defaults to **5**.
- `coverage` is `{ complete, knownServers, unknownServers }`. Global search covers known catalogs without starting every lazy server. Select an uncached server to discover it. Script search does not activate typed tools.
- `await tools.describe({ path, server? })` returns the complete tool descriptor with `path`, `server`, original `name`, and all server-supplied fields, including `inputSchema`, `outputSchema`, `title`, `annotations`, and `_meta` when present. It never substitutes `inputTypeScript`. Failures return `{ path, error: { code, message, suggestions? } }`. Supply `server` to disambiguate a name.
- `await tools.call(path, args)` returns `{ ok: true, data, resultRef? }` or `{ ok: false, error: { code, message, ... }, data?, resultRef? }`. `data` is the **raw MCP result**, including raw error-result data when available. Tools usually return `{ content, structuredContent?, isError?, ... }`; resource reads return `{ contents, ... }`.
- `await tools.resources({ server, limit?, offset? })` returns `{ mode: "resources", server, items, total, hasMore, nextOffset }`, or `{ error: { code, message } }`. Items preserve resource descriptors, including the exact `uri`, name, title, MIME type, description, icons, and `_meta` when supplied; pages default to 12, maximum 100.
- `await tools.readResource({ server, uri })` returns the same call envelope as `tools.call`, with raw resource contents in `data.contents`. Resources are separate from typed functions. Legacy `read_<resource>` call aliases remain compatible, but prefer this URI-based API.
- `await tools.readResult({ ref, path?, fields?, offset?, limit? })` returns `{ content, details }`, not a call envelope. `content` contains readback text; `details` contains `ref`, `offset`, `nextOffset`, `totalCharacters`, and the selected `path` when supplied. Failures contain `details.error` and `details.message`.
- `emit(value)` adds model-visible output before the final `return`; `console` output is captured too.

Treat `structuredContent` as structured data even alongside text or image blocks. Only parse a text block as JSON when the server documents that format. Handle `ok: false`: ordinary failed calls do not stop a script automatically. A call-capture failure stops dependent work. An ambiguous outcome requires provider readback before considering another write; never blindly repeat a call or rerun its whole script.

## Saved-result readback

Structured, media, resource, oversized, and extra-field results retain a raw artifact with a model-visible result reference. Small plain-text-only results stay inline. To inspect an existing reference without another MCP call:

```js
const page = await tools.readResult({
  ref: "/returned/result/path",
  path: "/structuredContent/rows",
  fields: ["id", "title"],
  offset: 0,
  limit: 12000,
});
return page;
```

`path` is an RFC 6901 JSON Pointer. `fields` retains immediate keys on the selected object or every object in a selected array. Selection precedes paging. `offset` and `limit` are **zero-based character positions in the selected, pretty-printed JSON**, not rows, lines, or bytes. The default limit is 12,000 characters; output byte/line caps still apply. Continue with `details.nextOffset` until it is `null`. References must identify existing adapter artifacts in the host's output directory. Readback never re-calls the server and is not a general filesystem API.

Gateway equivalents require explicit actions:

```js
mcp({ action: "search", query: "search issues", server: "github" })
mcp({ action: "describe", tool: "github_search_issues" })
mcp({ action: "call", tool: "github_search_issues", args: { query: "is:open" } })
mcp({ action: "resources", server: "docs" })
mcp({ action: "read-resource", server: "docs", uri: "docs://guide" })
mcp({ action: "read-result", ref: "/returned/result/path", path: "/structuredContent" })
```

Gateway search returns schemas without activating functions; use it when only `mcp` is allowed. New gateway calls use object `args`. Optional v5 mode fields and JSON-string arguments are only a stored-call ingress compatibility path.

## Execution rules

`tools` is a non-enumerable proxy: `Object.keys(tools)` throws. Use `tools.search` for discovery. Known flat paths support `tools.github_search_issues(args)` or `tools["server_tool-name"](args)`. Proxy API and promise/serialization names are reserved (`search`, `describe`, `call`, `resources`, `listResources`, `readResource`, `readResult`, `then`, `catch`, `finally`, `toJSON`, `toString`, `valueOf`); use `tools.call("exact-path", args)` for collisions.

Await every operation, including all promises started with `Promise.all`, before returning. Calls use the shared authentication, approval, filtering, cancellation, and capture path. Resources honor `exposeResources` and include/exclude policy. Raw results are cloned into the worker before model-facing rendering; reduce them before emitting to avoid unnecessary context. Result details include a concise search/describe/call trace and saved-result references.

The default overall script timeout is 30 seconds unless the host overrides or disables it; an explicit per-script `timeoutMs` wins. Individual MCP request deadlines still apply. The local worker terminates on timeout or cancellation, including infinite loops. This is trusted agent-authored local orchestration, not provider-native programmatic tool calling or an isolation boundary; Codex native PTC is not implied.

The worker exposes no Node, filesystem, or network globals such as `process`, `Buffer`, or `fetch`. Use normal JavaScript loops and Promise utilities; fluent helpers such as `tools.find(...).one()`, `tools.parallel(...)`, and `tools.retry(...)` do not exist. Run Pi in an isolated environment if you need isolation.
