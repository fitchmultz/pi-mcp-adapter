import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname } from "node:path";

const target = process.env.PI_MCP_EXAMPLE_DISAPPEAR_PATH;
if (target === undefined || target.length === 0) {
  throw new Error("The disappearing-config fixture requires an isolated config path");
}

const writeFile = fs.writeFile;
fs.writeFile = async (file, data, options) => {
  if (file === target) {
    await fs.rm(dirname(target), { recursive: true });
  }
  await writeFile(file, data, options);
};
syncBuiltinESMExports();
