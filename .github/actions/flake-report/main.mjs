#!/usr/bin/env node
// main.mjs <results-dir> <attempts>: summarise the attempts and open one issue per new flaky test.
import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BROKEN_TITLE, LABEL, plan } from './issues.mjs';
import { aggregate, readResults, render } from './report.mjs';

async function github(method, path, body) {
  const res = await fetch(`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 422 && path.endsWith('/labels')) return null;
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`);
  return res.status === 204 ? null : res.json();
}

async function openIssues(repo) {
  const all = [];
  for (let page = 1; ; page++) {
    const batch = await github('GET', `/repos/${repo}/issues?state=open&labels=${LABEL}&per_page=100&page=${page}`);
    all.push(...batch.filter((i) => !i.pull_request));
    if (batch.length < 100) return all;
  }
}

export async function main([dir, attemptsArg]) {
  const { files, results } = readResults(dir);
  const attempts = Number(attemptsArg) || 0;
  const repo = process.env.GITHUB_REPOSITORY;
  const runUrl = repo && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}` : '';
  const summary = aggregate(results);
  const markdown = render(summary, { attempts, runUrl, files });
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  if (!files || !summary.total) {
    console.log('::error::The attempts produced no test results. Check that each attempt wrote its result file.');
    return 1;
  }
  if (repo && process.env.GITHUB_TOKEN && process.env.FLAKE_OPEN_ISSUES !== 'false') {
    const ctx = { ref: process.env.FLAKE_REF ?? process.env.GITHUB_REF_NAME ?? '', sha: process.env.FLAKE_SHA ?? process.env.GITHUB_SHA ?? '', runUrl };
    await github('POST', `/repos/${repo}/labels`, { name: LABEL, color: 'fbca04', description: 'Found by the nightly flake hunt' });
    const open = await openIssues(repo);
    const actions = plan(summary, open.map((i) => i.title), ctx);
    for (const issue of actions.create) {
      const created = await github('POST', `/repos/${repo}/issues`, { ...issue, labels: [LABEL] });
      console.log(`Opened ${created.html_url}`);
    }
    if (actions.skipped > 0) console.log(`${actions.skipped} more flaky tests wait for the next run (at most 10 new issues per run).`);
    const brokenIssue = open.find((i) => i.title === BROKEN_TITLE);
    if (actions.broken && brokenIssue) await github('PATCH', `/repos/${repo}/issues/${brokenIssue.number}`, { body: actions.broken.body });
    else if (actions.broken) await github('POST', `/repos/${repo}/issues`, { ...actions.broken, labels: [LABEL] });
  }
  return summary.broken.length ? 1 : 0;
}

const self = realpathSync(fileURLToPath(import.meta.url));
if (process.argv[1] && realpathSync(process.argv[1]) === self) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (err) => {
      console.log(`::error::${err.message}`);
      process.exitCode = 1;
    },
  );
}
