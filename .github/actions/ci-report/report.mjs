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

const cell = (text) => text.replaceAll("|", "\\|");

export function renderScorecard(scorecard) {
  if (!scorecard) return ["### Scorecard", "", "Not measured: the scorecard step failed. See the run log.", ""];
  const lines = ["### Scorecard", "", "| Metric | Score | Deductions |", "|---|---|---|"];
  for (const metric of scorecard.metrics) {
    lines.push(`| ${metric.name} | ${metric.score}/10 | ${metric.deductions.map(cell).join("<br>") || "none"} |`);
  }
  const overall = scorecard.metrics.reduce((sum, metric) => sum + metric.score, 0) / scorecard.metrics.length;
  lines.push("", `Overall: **${overall.toFixed(1)}/10**`, "");
  const shown = scorecard.commentLines.slice(0, 10).map((line) => `\`${line}\``);
  const more = scorecard.commentLines.length - shown.length;
  if (shown.length) lines.push(`Source comment lines: ${shown.join(", ")}${more ? `, and ${more} more` : ""}.`, "");
  if (scorecard.unparsed.length) lines.push(`Not measured: ${scorecard.unparsed.map(cell).join("; ")}.`, "");
  return lines;
}

export function renderReport({ checks, timedOut, waitMinutes, runUrl, scorecard }) {
  const running = checks.filter((check) => !check.done).length;
  const lines = [MARKER, "", "### CI report", "", "Advisory. This report never blocks a merge.", ""];
  if (scorecard !== undefined) lines.push(...renderScorecard(scorecard));
  if (timedOut) {
    lines.push(`Stopped waiting after ${waitMinutes} minutes with ${running} check(s) still running.`, "");
  }
  if (checks.length === 0) {
    lines.push("No other checks ran on this commit.");
  } else {
    lines.push("| Check | Result |", "|---|---|");
    for (const check of checks) {
      lines.push(`| ${cell(check.name)} | ${check.result} |`);
    }
  }
  lines.push("", `[Run log](${runUrl})`);
  return lines.join("\n");
}

export function nextPageUrl(linkHeader) {
  return linkHeader?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
}
