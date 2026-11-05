#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";
import { loadExceptionSites, resolveExceptionSite } from "./quality-exceptions.mjs";

const negativeTypeTests = new Set([
  "__tests__/catalog-metadata.test-d.ts",
  "__tests__/fixtures/published-types-consumer.test-d.mts",
  "__tests__/oauth-config.test-d.ts",
  "__tests__/protocol-config.test-d.ts",
]);
const inventory = loadExceptionSites();
/** @type {Set<ReturnType<typeof resolveExceptionSite>>} */
const usedSites = new Set();

/**
 * @param {string} source
 * @param {import("oxc-parser").Comment} comment
 * @param {ReturnType<typeof resolveExceptionSite>[]} sites
 */
function lintDirectiveFailure(source, comment, sites) {
  const directive = comment.value
    .trim()
    .match(/^oxlint-disable-next-line ([\w-]+\/[\w-]+) -- (QX-\d+): \S.*$/u);
  const site = sites.find(
    (entry) =>
      directive !== null &&
      entry.rule === directive[1] &&
      entry.id === directive[2] &&
      /^\r?\n[\t ]*$/u.test(source.slice(comment.end, entry.start)),
  );
  if (comment.type !== "Line" || site === undefined) {
    return "lint directive is not authorized for this operation";
  }
  usedSites.add(site);
  return "";
}

/**
 * @param {string} file
 * @param {string} source
 * @param {import("oxc-parser").Comment} comment
 * @param {ReturnType<typeof resolveExceptionSite>[]} sites
 */
function directiveFailure(file, source, comment, sites) {
  const value = comment.value.trim();
  if (/^(?:oxlint|eslint)(?:-|\s|$)/u.test(value)) {
    return lintDirectiveFailure(source, comment, sites);
  }
  const typeValue =
    comment.type === "Line"
      ? comment.value.replace(/^\/+/u, "").trim()
      : (comment.value.split("\n").at(-1) ?? "").trim().replace(/^[/*]*\s*/u, "");
  if (/^@ts-(?:ignore|nocheck)/u.test(typeValue)) {
    return "TypeScript error suppression is not permitted";
  }
  if (!typeValue.startsWith("@ts-expect-error")) {
    return "";
  }
  if (!negativeTypeTests.has(file)) {
    return "negative type directives are restricted to approved type tests";
  }
  const description = typeValue.slice("@ts-expect-error".length);
  if (!/^\s/u.test(description) || description.trim().length < 10) {
    return "negative type directive needs a description of at least ten characters";
  }
  return "";
}

const files = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  {
    encoding: "utf8",
  },
)
  .split("\0")
  .filter((file) => /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(file) && existsSync(file))
  .sort();

let failed = false;
for (const file of files) {
  const source = readFileSync(file, "utf8");
  const parsed = parseSync(file, source);
  for (const error of parsed.errors) {
    console.error(`${file}: parse error: ${error.message}`);
    failed = true;
  }
  /** @type {ReturnType<typeof resolveExceptionSite>[]} */
  const sites = [];
  for (const entry of inventory.filter((item) => item.file === file)) {
    try {
      sites.push(resolveExceptionSite(entry, parsed.program, source));
    } catch (error) {
      console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      failed = true;
    }
  }
  for (const comment of parsed.comments) {
    const reason = directiveFailure(file, source, comment, sites);
    if (reason !== "") {
      const directiveOffset = reason.startsWith("lint")
        ? comment.value.search(/\S/u)
        : comment.value.lastIndexOf("@ts-");
      const line =
        source.slice(0, comment.start).split("\n").length +
        comment.value.slice(0, directiveOffset).split("\n").length -
        1;
      console.error(`${file}:${line}: ${reason}`);
      failed = true;
    }
  }
  for (const site of sites) {
    if (!usedSites.has(site)) {
      console.error(`${file}: unused exception site ${site.id} ${site.rule}`);
      failed = true;
    }
  }
}
for (const site of inventory) {
  if (!files.includes(site.file)) {
    console.error(`${site.file}: exception file is absent from maintained source`);
    failed = true;
  }
}
if (failed) {
  process.exitCode = 1;
}
