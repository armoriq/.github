import assert from "node:assert/strict";
import { test } from "node:test";
import { MARKER, collectChecks, nextPageUrl, pollDelayMs, renderReport, resolveWaitMinutes } from "./report.mjs";

test("wait minutes prefer the variable, then the secret, then 15", () => {
  assert.deepEqual(resolveWaitMinutes({ variable: "5", secret: "9" }), {
    minutes: 5,
    source: "repo variable CI_REPORT_WAIT_MINUTES",
  });
  assert.deepEqual(resolveWaitMinutes({ variable: "", secret: " 9 " }), {
    minutes: 9,
    source: "repo secret CI_REPORT_WAIT_MINUTES",
  });
  assert.deepEqual(resolveWaitMinutes({ variable: "", secret: "" }), { minutes: 15, source: "default" });
});

test("wait minutes reject values outside 1 to 300", () => {
  for (const bad of ["0", "301", "1.5", "ten", "-3"]) {
    assert.throws(() => resolveWaitMinutes({ variable: bad, secret: "" }), /repo variable/);
  }
  assert.throws(() => resolveWaitMinutes({ variable: "", secret: "abc" }), /repo secret/);
});

test("checks keep only the newest run per name and skip the report's own jobs", () => {
  const checks = collectChecks({
    checkRuns: [
      { id: 1, name: "PR size", status: "completed", conclusion: "cancelled" },
      { id: 3, name: "PR size", status: "completed", conclusion: "success" },
      { id: 2, name: "PR size", status: "completed", conclusion: "cancelled" },
      { id: 4, name: "CI report", status: "in_progress", conclusion: null },
      { id: 5, name: "build", status: "queued", conclusion: null },
    ],
    statuses: [],
    ownNames: new Set(["CI report"]),
  });
  assert.deepEqual(checks, [
    { name: "build", done: false, result: "queued" },
    { name: "PR size", done: true, result: "success" },
  ]);
});

test("commit statuses count as checks and pending ones keep the wait going", () => {
  const checks = collectChecks({
    checkRuns: [],
    statuses: [
      { context: "Vercel", state: "pending" },
      { context: "legacy-ci", state: "failure" },
    ],
    ownNames: new Set(),
  });
  assert.deepEqual(checks, [
    { name: "legacy-ci", done: true, result: "failure" },
    { name: "Vercel", done: false, result: "pending" },
  ]);
});

test("poll delay doubles from 15 seconds and caps at 60", () => {
  assert.deepEqual([0, 1, 2, 3, 9].map(pollDelayMs), [15_000, 30_000, 60_000, 60_000, 60_000]);
});

test("report lists each check and notes a timeout", () => {
  const body = renderReport({
    checks: [
      { name: "a|b", done: true, result: "success" },
      { name: "slow", done: false, result: "in_progress" },
    ],
    timedOut: true,
    waitMinutes: 15,
    runUrl: "https://example.test/run",
  });
  assert.ok(body.startsWith(MARKER));
  assert.match(body, /Stopped waiting after 15 minutes with 1 check\(s\) still running\./);
  assert.match(body, /\| a\\\|b \| success \|/);
  assert.match(body, /\| slow \| in_progress \|/);
  assert.match(body, /\[Run log\]\(https:\/\/example\.test\/run\)/);
});

test("report says so when nothing else ran", () => {
  const body = renderReport({ checks: [], timedOut: false, waitMinutes: 15, runUrl: "u" });
  assert.match(body, /No other checks ran on this commit\./);
  assert.doesNotMatch(body, /Stopped waiting/);
});

test("next page url comes from the link header", () => {
  assert.equal(
    nextPageUrl('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"'),
    "https://api.github.com/x?page=2",
  );
  assert.equal(nextPageUrl('<https://api.github.com/x?page=1>; rel="prev"'), undefined);
  assert.equal(nextPageUrl(null), undefined);
});
