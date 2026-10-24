import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const directory = process.argv[2];
assert.ok(directory);
const median = values => {
  const sorted = values.toSorted((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2;
};
const result = {};
let hash;
for (const side of ["A", "B"]) {
  const runs = Array.from({ length: 5 }, (_, i) => JSON.parse(readFileSync(join(directory, `${side}${i + 1}.json`))));
  result[side] = {};
  for (const run of runs) {
    hash ??= run.metadataSha256;
    assert.equal(run.metadataSha256, hash, "A and B must use byte-identical metadata");
    assert.deepEqual(run.work, { cacheLoads: 12, switches: 6, treeNavigations: 12, registeredTools: 651, errors: 0 });
  }
  for (const field of ["micro", "switchSession", "sessionTree"]) {
    const medians = runs.map(run => median(field === "micro" ? run[field].slice(1) : run[field]));
    result[side][field] = { medianOfRunMediansMs: median(medians), rangeMs: [Math.min(...medians), Math.max(...medians)], runMediansMs: medians };
  }
  result[side].coldCacheLoadMs = runs.map(run => run.micro[0]);
}
console.log(JSON.stringify({ metadataSha256: hash, ...result }, null, 2));
