#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";

const negativeTypeTests = new Set(["__tests__/fixtures/published-types-consumer.test-d.mts"]);

/**
 * @param {string} file
 * @param {import("oxc-parser").Comment} comment
 */
function directiveFailure(file, comment) {
  const value = comment.value.trim();
  if (/^(?:oxlint|eslint)(?:-|\s|$)/u.test(value)) {
    return "lint directive is not authorized";
  }
  const typeValue =
    comment.type === "Line"
      ? comment.value.replace(/^\/+/u, "").trim()
      : (comment.value.split("\n").at(-1) ?? "").trim();
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
  for (const comment of parsed.comments) {
    const reason = directiveFailure(file, comment);
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
}
if (failed) {
  process.exitCode = 1;
}
