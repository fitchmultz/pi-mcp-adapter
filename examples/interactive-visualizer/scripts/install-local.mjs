import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  configPath,
  distServer,
  isInstalledExample,
  loadConfig,
  serverName,
} from "./local-config.mjs";

const config = (await loadConfig()) ?? {};
const servers = config.mcpServers ?? {};
const existing = servers[serverName];

if (Boolean(existing) && !isInstalledExample(existing)) {
  console.error(
    `Refusing to overwrite existing ${serverName} entry in ${configPath} because it does not match this local example install.`,
  );
  process.exit(1);
}

servers[serverName] = {
  command: process.execPath,
  args: [distServer],
  lifecycle: "lazy",
};
config.mcpServers = servers;

await mkdir(path.dirname(configPath), { recursive: true });
await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
console.log(`Installed ${serverName} at ${configPath}`);
