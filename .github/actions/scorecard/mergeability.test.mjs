import assert from "node:assert/strict";
import { test } from "node:test";
import { failedChecks, isStacked, measureSize, migrationHazards, parseMergeTree, scoreMergeability } from "./mergeability.mjs";

const facts = (overrides = {}) => ({
  stacked: false,
  baseRef: "dev",
  behindBase: 0,
  conflicts: [],
  conflictTarget: "dev",
  size: { added: 10, deleted: 2, files: 3, overCap: false },
  migrationHazards: [],
  ...overrides,
});
const green = [{ name: "test", done: true, result: "success" }];

test("a PR is stacked when its base is neither the default branch nor a long-lived branch", () => {
  assert.equal(isStacked({ baseRef: "feat/part-1", defaultBranch: "dev" }), true);
  assert.equal(isStacked({ baseRef: "dev", defaultBranch: "dev" }), false);
  assert.equal(isStacked({ baseRef: "main", defaultBranch: "dev" }), false);
});

test("size leaves out lockfiles and exempts deletion PRs like the PR size check", () => {
  assert.deepEqual(measureSize("900\t50\tsrc/a.ts\n5000\t0\tpackage-lock.json\n100\t0\tsrc/b.ts\n"), {
    added: 1000, deleted: 50, files: 2, overCap: true,
  });
  assert.equal(measureSize("150\t3000\tsrc/old.ts\n").overCap, false);
  assert.equal(measureSize("-\t-\tlogo.png\n1\t0\ta.ts\n").files, 2);
});

test("merge-tree output yields the conflicted paths after the tree id", () => {
  assert.deepEqual(parseMergeTree("4b825dc\nsrc/a.ts\nsrc/b.ts\n"), ["src/a.ts", "src/b.ts"]);
});

test("a new migration must sort after the base's newest and not reuse its timestamp", () => {
  const basePaths = ["prisma/migrations/20260925120000_a/migration.sql", "prisma/migrations/20260929000000_b/migration.sql", "src/x.ts"];
  assert.deepEqual(
    migrationHazards({
      addedPaths: [
        "prisma/migrations/20260923000000_old/migration.sql",
        "prisma/migrations/20260929000000_clash/migration.sql",
        "prisma/migrations/20261001000000_ok/migration.sql",
      ],
      basePaths,
    }),
    ["migration 20260923000000 sorts before 20260929000000 on the base", "migration 20260929000000 reuses a timestamp already on the base"],
  );
  assert.deepEqual(migrationHazards({ addedPaths: ["src/a.ts"], basePaths: [] }), []);
});

test("failed checks ignore pullfrog and pending runs", () => {
  const checks = [
    { name: "pullfrog", result: "failure" },
    { name: "build", result: "cancelled" },
    { name: "lint", result: "in_progress" },
    { name: "test", result: "success" },
  ];
  assert.deepEqual(failedChecks(checks).map((check) => check.name), ["build"]);
});

test("a clean, current, green PR scores 10", () => {
  assert.deepEqual(scoreMergeability({ facts: facts(), checks: green, unresolvedThreads: 0 }), { score: 10, deductions: [] });
});

test("each mergeability problem costs its rubric points", () => {
  const scored = scoreMergeability({
    facts: facts({
      stacked: true,
      baseRef: "feat/part-1",
      behindBase: 2,
      conflicts: ["src/a.ts"],
      conflictTarget: "dev",
      size: { added: 1100, deleted: 0, files: 4, overCap: true },
      migrationHazards: ["migration 1 sorts before 2 on the base"],
    }),
    checks: [{ name: "build", done: true, result: "failure" }],
    unresolvedThreads: 6,
  });
  assert.equal(scored.score, 0);
  assert.deepEqual(scored.deductions, [
    "-3 conflicts with dev in src/a.ts",
    "-2 stack link broken: 2 commit(s) of feat/part-1 are not in this branch",
    "-2 1100 lines across 4 files, cap 1000 lines / 100 files",
    "-2 build failure",
    "-1 6 unresolved review threads",
    "-1 migration 1 sorts before 2 on the base",
  ]);
});

test("a PR on the default branch loses 1 for being behind, and 2 when no check ran", () => {
  assert.deepEqual(scoreMergeability({ facts: facts({ behindBase: 3 }), checks: [], unresolvedThreads: 0 }).deductions, [
    "-1 3 commit(s) behind dev",
    "-2 no other check ran on this commit",
  ]);
});
