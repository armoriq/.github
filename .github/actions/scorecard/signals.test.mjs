import assert from "node:assert/strict";
import { test } from "node:test";
import { lineSignals, loopAwaitSignals, scorePerformance } from "./performance.mjs";
import {
  concurrentIndexNames,
  documentedEnv,
  feederFindings,
  hygieneFindings,
  lockingFindings,
  scoreProductionization,
  undocumentedEnv,
} from "./production.mjs";
import { awaitsInLoops } from "./script_signals.mjs";

const lines = (entries) => new Map(entries.map((text, index) => [index + 1, text]));

test("a plain CREATE INDEX counts unless the repo also builds that index concurrently", () => {
  const sql = ['CREATE INDEX "a_idx" ON "t" ("x");', 'CREATE INDEX IF NOT EXISTS "b_idx"', '  ON "t" ("y");'];
  const findings = [
    { file: "m.sql", line: 0, rule_name: "require-concurrent-index-creation" },
    { file: "m.sql", line: 1, rule_name: "require-concurrent-index-creation" },
    { file: "m.sql", line: 0, rule_name: "require-lock-timeout" },
    { file: "m.sql", line: 2, rule_name: "constraint-missing-not-valid" },
  ];
  const concurrent = concurrentIndexNames('psql -c \'CREATE INDEX CONCURRENTLY IF NOT EXISTS "b_idx" ON "t" ("y")\'');
  assert.deepEqual([...concurrent], ["b_idx"]);
  assert.deepEqual(lockingFindings({ findings, sqlLines: new Map([["m.sql", sql]]), concurrentIndexes: concurrent }), [
    "m.sql:1 require-concurrent-index-creation",
    "m.sql:3 constraint-missing-not-valid",
  ]);
});

test("an index or constraint on a table the same migration creates blocks nothing", () => {
  const sql = [
    'CREATE TABLE "jobs" ("id" uuid);',
    'CREATE INDEX "jobs_idx" ON "jobs" ("id");',
    'ALTER TABLE "jobs"',
    '  ADD CONSTRAINT "fk" FOREIGN KEY ("id") REFERENCES "orgs" ("id");',
    'CREATE INDEX "spans_idx"',
    '  ON "spans" ("x");',
  ];
  const findings = [
    { file: "m.sql", line: 1, rule_name: "require-concurrent-index-creation" },
    { file: "m.sql", line: 3, rule_name: "adding-foreign-key-constraint" },
    { file: "m.sql", line: 5, rule_name: "require-concurrent-index-creation" },
  ];
  assert.deepEqual(lockingFindings({ findings, sqlLines: new Map([["m.sql", sql]]), concurrentIndexes: new Set() }), [
    "m.sql:6 require-concurrent-index-creation",
  ]);
});

test("env reads in added source must appear in .env.example, commented or not", () => {
  assert.deepEqual([...documentedEnv("A=1\n# B=\nexport C=x\nlower=1\n")], ["A", "B", "C"]);
  const addedSource = [
    "const a = process.env.A;",
    "const d = process.env.D ?? process.env['E'];",
    "x = os.getenv('F')",
    "y = os.environ['A']",
    "const k = this.config.get<string>('KMS_KEY');",
    "const s = config.getOrThrow('SECRET');",
    "map.get('key')",
  ];
  assert.deepEqual(undocumentedEnv({ addedSource, envExample: "A=1\n" }), ["D", "E", "F", "KMS_KEY", "SECRET"]);
  assert.deepEqual(undocumentedEnv({ addedSource, envExample: null }), []);
});

test("PR hygiene wants a linked issue, an issue for any workaround, and a screenshot for UI changes", () => {
  assert.deepEqual(hygieneFindings({ body: "Closes #12\n![shot](https://x/y.png)", changedPaths: ["src/App.tsx"] }), []);
  assert.deepEqual(hygieneFindings({ body: "A temporary workaround.", changedPaths: ["src/a.ts"] }), [
    [1, "the PR body links no issue"],
    [1, "the PR body calls the change temporary or a workaround with no linked issue"],
  ]);
  assert.deepEqual(hygieneFindings({ body: "Part 1 of 2 for #5", changedPaths: ["src/view.css"] }), [
    [2, "a UI file changed and the PR body has no screenshot"],
  ]);
  assert.deepEqual(hygieneFindings({ body: null, changedPaths: [] }), [[1, "the PR body links no issue"]]);
});

test("feeder checks cost points only when they finished without success", () => {
  const checks = [
    { name: "Deploy dry run", done: true, result: "failure" },
    { name: "DB specs ran", done: false, result: "in_progress" },
    { name: "build", done: true, result: "failure" },
  ];
  assert.deepEqual(feederFindings(checks), [[4, "the deploy dry run failed"]]);
});

test("productionization adds every deduction and floors at 0", () => {
  const scored = scoreProductionization({
    facts: {
      lockingMigrations: ["m.sql:1 require-concurrent-index-creation"],
      undocumentedEnv: ["KEY"],
      hygiene: [[1, "the PR body links no issue"]],
    },
    checks: [{ name: "Deploy dry run", done: true, result: "failure" }],
  });
  assert.equal(scored.score, 2);
  assert.deepEqual(scored.deductions, [
    "-2 migration blocks writes: m.sql:1 require-concurrent-index-creation",
    "-1 KEY is read but missing from .env.example",
    "-1 the PR body links no issue",
    "-4 the deploy dry run failed",
  ]);
});

test("line signals flag blocking I/O, fast refetching and sleeps in runtime code only", () => {
  const added = lines(["const a = readFileSync(p);", "refetchInterval: 30_000,", "refetchInterval: 300_000,", "time.sleep(1)"]);
  assert.deepEqual(lineSignals({ path: "src/a.py", added }).map(([points]) => points), [2, 1, 2]);
  assert.deepEqual(lineSignals({ path: "scripts/build.ts", added }), []);
  assert.deepEqual(lineSignals({ path: "src/a.ts", added: lines(["refetchInterval: 30_000,"]) }), [
    [1, "src/a.ts:1 refetchInterval 30_000 ms is under 60000 ms"],
  ]);
});

test("awaits in loops count only round trips, and reset inside nested functions and for-await", () => {
  const code = [
    "async function a(ids) {",
    "  for (const id of ids) {",
    "    await this.prisma.user.findUnique({ where: { id } });",
    "    await sleep(1);",
    "  }",
    "  await prisma.x.findMany();",
    "  while (more) { const f = async () => { await fetch(u); }; }",
    "  for await (const row of stream) { await db.query(row); }",
    "}",
  ].join("\n");
  const awaits = awaitsInLoops(code, "src/a.ts");
  assert.deepEqual(awaits, [{ line: 3, call: "this.prisma.user.findUnique({ where: { id } })" }]);
  assert.deepEqual(loopAwaitSignals({ path: "src/a.ts", awaits, added: lines(["", "", "x"]) }).map(([points]) => points), [2]);
  assert.deepEqual(loopAwaitSignals({ path: "src/a.ts", awaits, added: new Map() }), []);
});

test("performance score subtracts each signal", () => {
  assert.deepEqual(scorePerformance([[2, "a"], [1, "b"]]), { score: 7, deductions: ["-2 a", "-1 b"] });
});
