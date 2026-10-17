import { appendFile, readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import {
  MARKER,
  collectChecks,
  nextPageUrl,
  pollDelayMs,
  renderReport,
  resolveWaitMinutes,
} from "./report.mjs";

const env = process.env;
const repo = env.GITHUB_REPOSITORY;
const token = env.INPUT_TOKEN;
const etagCache = new Map();

async function request(url, { method = "GET", body } = {}) {
  const cached = method === "GET" ? etagCache.get(url) : undefined;
  const response = await fetch(url, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(cached && { "if-none-match": cached.etag }),
    },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 304) return cached.page;
  if (!response.ok) {
    throw new Error(`${method} ${url} returned ${response.status}: ${await response.text()}`);
  }
  const page = { data: await response.json(), next: nextPageUrl(response.headers.get("link")) };
  const etag = response.headers.get("etag");
  if (method === "GET" && etag) etagCache.set(url, { etag, page });
  return page;
}

async function listAll(path, pick) {
  const items = [];
  for (let url = `${env.GITHUB_API_URL}${path}`; url; ) {
    const page = await request(url);
    items.push(...pick(page.data));
    url = page.next;
  }
  return items;
}

async function main() {
  const { pull_request: pr } = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
  if (!pr) {
    console.log("Not a pull request event. Skipping.");
    return;
  }

  const { minutes, source } = resolveWaitMinutes({
    variable: env.INPUT_WAIT_VARIABLE,
    secret: env.INPUT_WAIT_SECRET,
  });
  console.log(`Waiting up to ${minutes} minutes (${source}).`);

  const ownNames = new Set(
    await listAll(`/repos/${repo}/actions/runs/${env.GITHUB_RUN_ID}/jobs?per_page=100`, (data) =>
      data.jobs.map((job) => job.name),
    ),
  );
  const loadChecks = async () => {
    const [checkRuns, statuses] = await Promise.all([
      listAll(`/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`, (data) => data.check_runs),
      listAll(`/repos/${repo}/commits/${pr.head.sha}/status?per_page=100`, (data) => data.statuses),
    ]);
    return collectChecks({ checkRuns, statuses, ownNames });
  };

  const deadline = Date.now() + minutes * 60_000;
  let checks = await loadChecks();
  for (let attempt = 0; checks.some((check) => !check.done) && Date.now() < deadline; attempt++) {
    console.log(`${checks.filter((check) => !check.done).length} check(s) still running.`);
    await sleep(Math.min(pollDelayMs(attempt), deadline - Date.now()));
    checks = await loadChecks();
  }

  const body = renderReport({
    checks,
    timedOut: checks.some((check) => !check.done),
    waitMinutes: minutes,
    runUrl: `${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`,
  });
  await appendFile(env.GITHUB_STEP_SUMMARY, `${body}\n`);

  if (pr.head.repo?.full_name !== repo) {
    console.log("Fork pull request. The token cannot comment, so the report is in the run summary.");
    return;
  }

  const comments = await listAll(`/repos/${repo}/issues/${pr.number}/comments?per_page=100`, (data) => data);
  const existing = comments.find((comment) => comment.user?.type === "Bot" && comment.body?.includes(MARKER));
  if (existing) {
    await request(`${env.GITHUB_API_URL}/repos/${repo}/issues/comments/${existing.id}`, { method: "PATCH", body: { body } });
  } else {
    await request(`${env.GITHUB_API_URL}/repos/${repo}/issues/${pr.number}/comments`, { method: "POST", body: { body } });
  }
}

main().catch((error) => {
  console.log(`::error::${error.message}`);
  process.exitCode = 1;
});
