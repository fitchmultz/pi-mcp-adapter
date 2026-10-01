#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// npm TypeScript has no Android binary; use Termux's Android-native compiler.
const termux = process.platform === "android";
const result = spawnSync(
	termux ? "tsgo" : process.execPath,
	[...(termux ? [] : [join(process.cwd(), "node_modules/typescript/bin/tsc")]), ...process.argv.slice(2)],
	{ stdio: "inherit" },
);
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
