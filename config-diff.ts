function longestCommonSubsequences(before: string[], after: string[]): number[][] {
  const lcs = Array.from({ length: before.length + 1 }, () =>
    Array<number>(after.length + 1).fill(0),
  );
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      const row = lcs[i];
      const nextRow = lcs[i + 1];
      if (!row || !nextRow) {
        continue;
      }
      row[j] =
        before[i] === after[j]
          ? (nextRow[j + 1] ?? 0) + 1
          : Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  return lcs;
}

function preferAddedLine(lcs: number[][], i: number, j: number, rowCount: number): boolean {
  return i === rowCount || (lcs[i]?.[j + 1] ?? 0) >= (lcs[i + 1]?.[j] ?? 0);
}

export function buildUnifiedDiff(beforeText: string, afterText: string): string {
  if (beforeText === afterText) {
    return "(no changes)";
  }
  const before = beforeText.split("\n");
  const after = afterText.split("\n");
  const lcs = longestCommonSubsequences(before, after);
  const lines = ["--- before", "+++ after"];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      lines.push(`  ${String(before[i])}`);
      i++;
      j++;
    } else if (j < after.length && preferAddedLine(lcs, i, j, before.length)) {
      lines.push(`+ ${String(after[j])}`);
      j++;
    } else if (i < before.length) {
      lines.push(`- ${String(before[i])}`);
      i++;
    }
  }
  return lines.join("\n");
}
