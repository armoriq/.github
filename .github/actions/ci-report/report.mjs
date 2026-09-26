export const MARKER = "<!-- org-ci-report -->";
export const DEFAULT_WAIT_MINUTES = 15;
export const MAX_WAIT_MINUTES = 300;

export function resolveWaitMinutes({ variable, secret }) {
  const [raw, source] = variable?.trim()
    ? [variable.trim(), "repo variable CI_REPORT_WAIT_MINUTES"]
    : secret?.trim()
      ? [secret.trim(), "repo secret CI_REPORT_WAIT_MINUTES"]
      : [String(DEFAULT_WAIT_MINUTES), "default"];
  const minutes = Number(raw);
  if (!/^\d+$/.test(raw) || minutes < 1 || minutes > MAX_WAIT_MINUTES) {
    throw new Error(`The ${source} must be a whole number of minutes from 1 to ${MAX_WAIT_MINUTES}.`);
  }
  return { minutes, source };
}

export function collectChecks({ checkRuns, statuses, ownNames }) {
  const latestRuns = new Map();
  for (const run of checkRuns) {
    if (ownNames.has(run.name)) continue;
    const seen = latestRuns.get(run.name);
    if (!seen || run.id > seen.id) latestRuns.set(run.name, run);
  }
  const fromRuns = [...latestRuns.values()].map((run) => ({
    name: run.name,
    done: run.status === "completed",
    result: run.status === "completed" ? run.conclusion : run.status,
  }));
  const fromStatuses = statuses.map((status) => ({
    name: status.context,
    done: status.state !== "pending",
    result: status.state,
  }));
  return [...fromRuns, ...fromStatuses].sort((a, b) => a.name.localeCompare(b.name));
}

export function pollDelayMs(attempt) {
  return Math.min(15_000 * 2 ** attempt, 60_000);
}

export function renderReport({ checks, timedOut, waitMinutes, runUrl }) {
  const running = checks.filter((check) => !check.done).length;
  const lines = [MARKER, "", "### CI report", "", "Advisory. This report never blocks a merge.", ""];
  if (timedOut) {
    lines.push(`Stopped waiting after ${waitMinutes} minutes with ${running} check(s) still running.`, "");
  }
  if (checks.length === 0) {
    lines.push("No other checks ran on this commit.");
  } else {
    lines.push("| Check | Result |", "|---|---|");
    for (const check of checks) {
      lines.push(`| ${check.name.replaceAll("|", "\\|")} | ${check.result} |`);
    }
  }
  lines.push("", `[Run log](${runUrl})`);
  return lines.join("\n");
}

export function nextPageUrl(linkHeader) {
  return linkHeader?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
}
