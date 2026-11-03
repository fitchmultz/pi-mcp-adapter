import { writeFile } from "node:fs/promises";
import { configPath, isInstalledExample, loadConfig, serverName } from "./local-config.mjs";

try {
  const config = await loadConfig();
  if (config === undefined) {
    console.log(`No MCP config found at ${configPath}`);
  } else {
    const servers = config.mcpServers;
    const entry = servers?.[serverName];
    const hasEntry = Boolean(entry);
    if (!hasEntry || servers === null || servers === undefined) {
      console.log(`${serverName} is not installed in ${configPath}`);
    } else if (!isInstalledExample(entry)) {
      console.log(
        `Left ${serverName} unchanged because the existing entry does not match this local example install.`,
      );
    } else {
      delete servers[serverName];
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
      console.log(`Removed ${serverName} from ${configPath}`);
    }
  }
} catch (error) {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    console.log(`No MCP config found at ${configPath}`);
  } else {
    throw error;
  }
}
