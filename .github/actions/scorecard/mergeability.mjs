export const MAX_LINES = 1000;
export const MAX_FILES = 100;
export const DELETION_MAX_ADDED = 200;
export const MAX_UNRESOLVED_THREADS = 5;
export const IGNORED_CHECKS = new Set(["pullfrog"]);

const LOCKFILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|npm-shrinkwrap\.json|poetry\.lock|Pipfile\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock|uv\.lock|flake\.lock|bun\.lockb?)$/;
const LONG_LIVED = /^(main|master|dev|develop|development|staging|production)$/;
const MIGRATION = /(^|\/)migrations\/(\d{8,14})[_-][^/]+\//;
const FAILED = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure", "error"]);

export function isStacked({ baseRef, defaultBranch }) {
  return baseRef !== defaultBranch && !LONG_LIVED.test(baseRef);
}

export function measureSize(numstat) {
  let added = 0;
  let deleted = 0;
  let files = 0;
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [plus, minus, path] = line.split("\t");
    if (LOCKFILE.test(path)) continue;
    added += Number(plus) || 0;
    deleted += Number(minus) || 0;
    files += 1;
  }
  const deletionExempt = deleted > added && added <= DELETION_MAX_ADDED;
  return { added, deleted, files, overCap: !deletionExempt && (added + deleted > MAX_LINES || files > MAX_FILES) };
}

export function parseMergeTree(output) {
  const [, ...rest] = output.split("\n");
  return rest.filter(Boolean);
}

export function migrationTimestamp(path) {
  return path.match(MIGRATION)?.[2];
}

export function migrationHazards({ addedPaths, basePaths }) {
  const baseStamps = new Map(basePaths.map((path) => [migrationTimestamp(path), path]).filter(([stamp]) => stamp));
  const newest = [...baseStamps.keys()].sort().at(-1);
  const added = [...new Set(addedPaths.map(migrationTimestamp).filter(Boolean))];
  return added.flatMap((stamp) => {
    if (baseStamps.has(stamp)) return [`migration ${stamp} reuses a timestamp already on the base`];
    if (newest && stamp < newest) return [`migration ${stamp} sorts before ${newest} on the base`];
    return [];
  });
}

export function failedChecks(checks) {
  return checks.filter((check) => !IGNORED_CHECKS.has(check.name) && FAILED.has(check.result));
}

const RULES = [
  ({ facts }) => facts.conflicts.length > 0 && [3, `conflicts with ${facts.conflictTarget} in ${facts.conflicts.slice(0, 3).join(", ")}`],
  ({ facts }) => facts.behindBase > 0 && facts.stacked && [2, `stack link broken: ${facts.behindBase} commit(s) of ${facts.baseRef} are not in this branch`],
  ({ facts }) => facts.behindBase > 0 && !facts.stacked && [1, `${facts.behindBase} commit(s) behind ${facts.baseRef}`],
  ({ facts: { size } }) => size.overCap && [2, `${size.added + size.deleted} lines across ${size.files} files, cap ${MAX_LINES} lines / ${MAX_FILES} files`],
  ({ checks }) => checks.length === 0 && [2, "no other check ran on this commit"],
  ({ checks }) => failedChecks(checks).length > 0 && [2, failedChecks(checks).map((check) => `${check.name} ${check.result}`).join(", ")],
  ({ unresolvedThreads }) => unresolvedThreads > MAX_UNRESOLVED_THREADS && [1, `${unresolvedThreads} unresolved review threads`],
];

export function scoreMergeability(input) {
  const hits = [...RULES.map((rule) => rule(input)).filter(Boolean), ...input.facts.migrationHazards.map((hazard) => [1, hazard])];
  const lost = hits.reduce((sum, [points]) => sum + points, 0);
  return { score: Math.max(0, 10 - lost), deductions: hits.map(([points, reason]) => `-${points} ${reason}`) };
}
