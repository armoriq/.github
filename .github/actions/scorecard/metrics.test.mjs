import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commentSyntax,
  complexityFlags,
  countComments,
  densityDeduction,
  isTestPath,
  scoreCleanCode,
  scoreComplexity,
} from "./metrics.mjs";
import { measureScript } from "./script_complexity.mjs";

const lines = (entries) => new Map(entries.map((text, index) => [index + 1, text]));

test("comment syntax follows the file type and skips generated and lock files", () => {
  assert.equal(commentSyntax("src/a.ts"), "slash");
  assert.equal(commentSyntax("web/App.tsx"), "slash");
  assert.equal(commentSyntax("prisma/schema.prisma"), "slash");
  assert.equal(commentSyntax("pkg/mod.py"), "hash");
  assert.equal(commentSyntax("prisma/migrations/1/migration.sql"), "sql");
  assert.equal(commentSyntax("README.md"), null);
  assert.equal(commentSyntax("dist/a.js"), null);
  assert.equal(commentSyntax("types/a.d.ts"), null);
  assert.equal(commentSyntax("package-lock.json"), null);
});

test("test paths cover spec files, test folders and pytest modules", () => {
  for (const path of ["src/a.spec.ts", "test/x.ts", "web/a.test.tsx", "tests/test_a.py", "pkg/a_test.py", "conftest.py"]) {
    assert.equal(isTestPath(path), true, path);
  }
  for (const path of ["src/a.ts", "pkg/testing_tools.py", "src/latest.ts"]) {
    assert.equal(isTestPath(path), false, path);
  }
});

test("slash comments count line, block, JSDoc and JSX comments but not code or blanks", () => {
  const counted = countComments({
    path: "a.tsx",
    added: lines(["// one", "/* two", " * three", " */", "{/* four */}", "const a = 1; // trailing", "", "const url = 'http://x';"]),
  });
  assert.deepEqual(counted, { added: 7, comments: 5, lines: [1, 2, 3, 4, 5] });
});

test("python counts hash comments and docstring lines, never the shebang", () => {
  const counted = countComments({
    path: "a.py",
    added: lines(["#!/usr/bin/env python", "# note", 'def f():', '    """Doc."""', "    return 1"]),
    docstringLines: new Set([4]),
  });
  assert.deepEqual(counted, { added: 5, comments: 2, lines: [2, 4] });
});

test("sql counts double-dash comments only", () => {
  const counted = countComments({ path: "m.sql", added: lines(["-- why", "CREATE INDEX a ON b (c);"]) });
  assert.deepEqual(counted, { added: 2, comments: 1, lines: [1] });
});

test("density deduction buckets start above the 0.02% target", () => {
  assert.deepEqual([0, 0.0002, 0.0003, 0.01, 0.0101, 0.05, 0.15, 0.4].map(densityDeduction), [0, 0, 1, 1, 2, 2, 3, 4]);
});

test("clean code names the lines to delete", () => {
  assert.deepEqual(scoreCleanCode({ added: 100, comments: 10 }), {
    score: 7,
    deductions: ["-3 source comments 10.00% of 100 added lines, target 0.02%: delete 10 line(s)"],
  });
  assert.deepEqual(scoreCleanCode({ added: 0, comments: 0 }), { score: 10, deductions: [] });
});

test("complexity flags new, grown and touched functions only where the diff reaches them", () => {
  const before = [
    { name: "grows", complexity: 2, start: 1, end: 10 },
    { name: "big", complexity: 15, start: 11, end: 40 },
    { name: "untouched", complexity: 30, start: 41, end: 60 },
  ];
  const after = [
    { name: "grows", complexity: 6, start: 1, end: 12 },
    { name: "big", complexity: 15, start: 13, end: 42 },
    { name: "untouched", complexity: 30, start: 43, end: 62 },
    { name: "fresh", complexity: 11, start: 63, end: 80 },
    { name: "small", complexity: 3, start: 81, end: 90 },
  ];
  const flags = complexityFlags({ path: "a.ts", before, after, addedLines: [5, 20, 70, 85] });
  assert.deepEqual(flags.map((flag) => [flag.name, flag.kind]), [
    ["grows", "grown"],
    ["big", "touched"],
    ["fresh", "new"],
  ]);
});

test("functions with the same name match by order, so an anonymous callback is not new", () => {
  const fn = (complexity, start) => ({ name: "anonymous", complexity, start, end: start + 5 });
  const flags = complexityFlags({ path: "a.ts", before: [fn(12, 1), fn(2, 10)], after: [fn(12, 2), fn(2, 11)], addedLines: [3] });
  assert.deepEqual(flags.map((flag) => flag.kind), ["touched"]);
});

test("complexity score subtracts 2 per new or grown function and 1 per touched one", () => {
  const scored = scoreComplexity([
    { path: "a.ts", line: 1, name: "grows", complexity: 6, was: 2, kind: "grown" },
    { path: "a.ts", line: 9, name: "fresh", complexity: 11, kind: "new" },
    { path: "a.ts", line: 20, name: "big", complexity: 15, was: 15, kind: "touched" },
  ]);
  assert.equal(scored.score, 5);
  assert.deepEqual(scored.deductions, [
    "-2 grows (a.ts:1) grew from 2 to 6",
    "-2 fresh (a.ts:9) is new at 11",
    "-1 big (a.ts:20) is 15 and the change didn't grow it",
  ]);
  assert.equal(scoreComplexity(Array(9).fill({ path: "a", line: 1, name: "f", complexity: 12, kind: "new" })).score, 0);
});

test("script complexity matches ESLint's rule and spans the whole function", () => {
  const code = [
    "export class A {",
    "  @dec()",
    "  async run(a: number) {",
    "    if (a > 1 && a < 5) return 1;",
    "    return a ?? 0;",
    "  }",
    "}",
    "export const f = (x?: string) => x?.length;",
  ].join("\n");
  assert.deepEqual(measureScript(code, "a.ts"), [
    { name: "run", complexity: 4, start: 2, end: 6 },
    { name: "f", complexity: 2, start: 8, end: 8 },
  ]);
});

test("an eslint-disable comment cannot hide a function from the measurement", () => {
  const code = "/* eslint-disable complexity */\n// eslint-disable-next-line no-console\nfunction f(a) { if (a) return 1; return 2; }";
  assert.deepEqual(measureScript(code, "a.ts"), [{ name: "f", complexity: 2, start: 3, end: 3 }]);
});

test("script complexity parses JSX only in jsx and tsx files", () => {
  assert.deepEqual(measureScript("export const C = () => <div>{1}</div>;", "C.tsx").map((fn) => fn.complexity), [1]);
  assert.deepEqual(measureScript("export const id = <T,>(x: T) => x;", "a.ts").map((fn) => fn.name), ["id"]);
  assert.throws(() => measureScript("const = ;", "bad.ts"), /bad\.ts:1/);
});
