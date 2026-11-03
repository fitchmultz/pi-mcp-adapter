import assert from "node:assert/strict";
import { runInContext, type Context } from "node:vm";
import { transform } from "esbuild";
import { parseSync } from "oxc-parser";
import { expect } from "vitest";
import { z } from "zod";

const NATIVE_BRIDGE = "@modelcontextprotocol/ext-apps/app-bridge";
const importMapSchema = z.object({ imports: z.record(z.string(), z.string()) });

interface HostModuleImport {
  specifier: string;
  global: string;
  names: string[];
}

export interface HostModuleGraph {
  script: string;
  imports: HostModuleImport[];
  modules: string[];
}

// Bind each native import from the module its served import map selects;
// execute all remaining served bytes unchanged in the DOM's own VM realm.
function hostModuleScript(
  source: string,
  moduleGlobal: (specifier: string) => string,
): { script: string; imports: HostModuleImport[] } {
  const parsed = parseSync("host-browser.js", source);
  if (parsed.errors.length > 0) {
    throw new Error("Cannot parse served host module");
  }
  const declarations = parsed.program.body.filter((node) => node.type === "ImportDeclaration");
  if (!declarations.some((declaration) => declaration.source.value === NATIVE_BRIDGE)) {
    throw new Error("Unexpected host module import");
  }
  const imports: HostModuleImport[] = [];
  let script = "";
  let offset = 0;
  for (const declaration of declarations) {
    const specifier = declaration.source.value;
    const global = moduleGlobal(specifier);
    const names: string[] = [];
    const bindings = declaration.specifiers.map((binding) => {
      if (binding.type !== "ImportSpecifier" || binding.imported.type !== "Identifier") {
        throw new Error("Unexpected native import binding");
      }
      const name = binding.imported.name;
      // A custom bridge URL replaces only this specifier and supplies only these exports.
      if (specifier === NATIVE_BRIDGE && name !== "AppBridge" && name !== "PostMessageTransport") {
        throw new Error(`Unexpected native bridge export: ${name}`);
      }
      names.push(name);
      return `${name}: ${binding.local.name}`;
    });
    imports.push({ specifier, global, names });
    script += `${source.slice(offset, declaration.start)}
    const { ${bindings.join(", ")} } = ${global};`;
    offset = declaration.end;
  }
  return { script: `(async () => { ${script}${source.slice(offset)} })()`, imports };
}

// Node's VM does not resolve HTML import maps. Load one module instance per URL
// the served import map selects, as in the browser's module map.
export async function loadHostModuleGraph(html: string, origin: string): Promise<HostModuleGraph> {
  const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  if (source === undefined || source === "") {
    throw new Error("Served host module not found");
  }
  const importMap = importMapSchema.parse(
    JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1] ?? "null"),
  );
  const moduleUrls: string[] = [];
  const moduleGlobal = (specifier: string): string => {
    const url = importMap.imports[specifier];
    if (url === undefined) {
      throw new Error(`Unmapped host import: ${specifier}`);
    }
    const href = new URL(url, origin).href;
    const index = moduleUrls.includes(href) ? moduleUrls.indexOf(href) : moduleUrls.push(href) - 1;
    return `hostImport${String(index)}`;
  };
  const { script, imports } = hostModuleScript(source, moduleGlobal);
  const modules: string[] = [];
  for (const [index, href] of moduleUrls.entries()) {
    const served = await fetch(href);
    expect(served.status).toBe(200);
    const loaded = await transform(await served.text(), {
      format: "iife",
      globalName: `hostImport${String(index)}`,
    });
    modules.push(loaded.code);
  }
  return { script, imports, modules };
}

export async function evaluateHostModules(graph: HostModuleGraph, context: Context): Promise<void> {
  for (const code of graph.modules) {
    const loaded: unknown = runInContext(code, context);
    await loaded;
  }
  for (const { specifier, global, names } of graph.imports) {
    const module: unknown = runInContext(global, context);
    for (const name of names) {
      // Browsers reject a module graph whose served module lacks an imported binding.
      assert(
        typeof module === "object" && module !== null && name in module,
        `${specifier} does not provide ${name}`,
      );
    }
  }
}
