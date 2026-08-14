#!/usr/bin/env node
/**
 * Purpose: Produce the compiled runtime files that the Pi extension manifest loads.
 * Responsibilities: Run TypeScript emit into a staging directory, copy runtime assets
 * that modules resolve as dist-relative siblings, then atomically swap it into dist/
 * so a failed build never destroys a previously working dist.
 * Usage: `npm run build`; also invoked by scripts/prepare.mjs during install lifecycles.
 */

import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
// Run tsc's JS entrypoint directly through the current node binary: no .cmd shim,
// no shell, safe for install paths containing spaces on every platform.
const tscPath = join(process.cwd(), "node_modules", "typescript", "bin", "tsc");

// Runtime siblings resolved relative to the compiled module directory
// (mcp-auth.ts, mcp-code.ts, ui-server.ts).
const RUNTIME_ASSETS = ["mcp-keyring-helper.cjs", "mcp-script-worker.mjs", "app-bridge.bundle.js"];

async function main() {
	if (!existsSync(tscPath)) {
		throw new Error(`typescript is not installed at ${tscPath}; run npm install first.`);
	}
	const stagingDir = join(process.cwd(), "dist.staging");
	await rm(stagingDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
	try {
		const { stderr, stdout } = await execFile(
			process.execPath,
			[tscPath, "-p", "tsconfig.build.json", "--outDir", stagingDir],
			{ cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 },
		);
		if (stdout) process.stdout.write(stdout);
		if (stderr) process.stderr.write(stderr);
		for (const asset of RUNTIME_ASSETS) {
			await copyFile(join(process.cwd(), asset), join(stagingDir, asset));
		}
	} catch (error) {
		await rm(stagingDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
		if (error?.stdout) process.stdout.write(error.stdout);
		if (error?.stderr) process.stderr.write(error.stderr);
		throw error;
	}
	await rm(join(process.cwd(), "dist"), { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
	await rename(stagingDir, join(process.cwd(), "dist"));
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
