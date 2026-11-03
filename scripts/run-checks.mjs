import spawn from "cross-spawn";

/**
 * Run independent native commands, retaining failures and honoring actual build prerequisites.
 * @param {ReadonlyArray<{name: string, command: string, args: readonly string[], requires?: readonly string[]}>} checks
 * @returns {number}
 */
export function runChecks(checks) {
  /** @type {Map<string, number>} */
  const statuses = new Map();
  for (const check of checks) {
    const blocked = check.requires?.filter((name) => statuses.get(name) !== 0) ?? [];
    if (blocked.length > 0) {
      console.error(`[check] ${check.name}: blocked by ${blocked.join(", ")}`);
      statuses.set(check.name, 1);
      continue;
    }
    console.log(`[check] ${check.name}: ${check.command} ${check.args.join(" ")}`);
    const result = spawn.sync(check.command, [...check.args], { stdio: "inherit" });
    if (result.error) {
      console.error(result.error.message);
    }
    if (result.signal !== null) {
      console.error(`[check] ${check.name}: signal ${result.signal}`);
    }
    const status = result.status ?? 1;
    statuses.set(check.name, status);
    console.log(`[check] ${check.name}: exit ${status}`);
  }
  const failed = [...statuses].filter(([, status]) => status !== 0).map(([name]) => name);
  if (failed.length > 0) {
    console.error(`[check] failed or blocked: ${failed.join(", ")}`);
    return 1;
  }
  return 0;
}
