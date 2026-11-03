import { parseSync } from "oxc-parser";

// Node's VM does not resolve HTML import maps. Bind only that native import;
// execute all remaining served bytes unchanged in the DOM's own VM realm.
export function hostModuleScript(source: string): string {
  const parsed = parseSync("host-browser.js", source);
  if (parsed.errors.length > 0) {
    throw new Error("Cannot parse served host module");
  }
  const imports = parsed.program.body.filter((node) => node.type === "ImportDeclaration");
  const declaration = imports[0];
  if (
    imports.length !== 1 ||
    declaration === undefined ||
    declaration.source.value !== "@modelcontextprotocol/ext-apps/app-bridge"
  ) {
    throw new Error("Unexpected host module import");
  }
  const bindings = declaration.specifiers.map((specifier) => {
    if (specifier.type !== "ImportSpecifier" || specifier.imported.type !== "Identifier") {
      throw new Error("Unexpected native bridge import binding");
    }
    const name = specifier.imported.name;
    if (name !== "AppBridge" && name !== "PostMessageTransport") {
      throw new Error(`Unexpected native bridge export: ${name}`);
    }
    return `${name}: ${specifier.local.name}`;
  });
  return `(async () => { ${source.slice(0, declaration.start)}
    const { ${bindings.join(", ")} } = bridgeModule;
    ${source.slice(declaration.end)} })()`;
}
