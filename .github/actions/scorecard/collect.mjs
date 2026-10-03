import { execFileSync, spawnSync } from "node:child_process";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commentSyntax, complexityFlags, countComments, isTestPath, scoreCleanCode, scoreComplexity } from "./metrics.mjs";
import { isStacked, measureSize, migrationHazards, parseMergeTree } from "./mergeability.mjs";
import { measureScript } from "./script_complexity.mjs";

const SCRIPT = /\.(c|m)?[jt]sx?$/;
const PYTHON = /\.py$/;
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

function changedFiles(base, head) {
  return git("diff", "--name-status", "--find-renames", base, head)
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .filter(([status]) => !status.startsWith("D"))
    .map((parts) => ({ before: parts[1], path: parts.at(-1), added: parts[0] === "A" }));
}

function addedLines(base, head, path) {
  const added = new Map();
  let line = 0;
  for (const text of git("diff", "-U0", base, head, "--", path).split("\n")) {
    const hunk = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) line = Number(hunk[1]);
    else if (text.startsWith("+") && !text.startsWith("+++")) added.set(line++, text.slice(1));
  }
  return added;
}

function show(commit, path) {
  try {
    return git("show", `${commit}:${path}`);
  } catch {
    return "";
  }
}

function measurePython(code, path) {
  if (!code) return { functions: [], docstrings: [] };
  const out = execFileSync("python3", [join(import.meta.dirname, "python_metrics.py"), path], { input: code, encoding: "utf8" });
  return JSON.parse(out);
}

function measureFile(code, path) {
  if (SCRIPT.test(path)) return { functions: measureScript(code, path), docstrings: [] };
  if (PYTHON.test(path)) return measurePython(code, path);
  return { functions: [], docstrings: [] };
}

function collect(base, head) {
  const mergeBase = git("merge-base", base, head).trim();
  const density = { source: { added: 0, comments: 0 }, test: { added: 0, comments: 0 } };
  const commentLines = [];
  const flags = [];
  const unparsed = [];
  for (const file of changedFiles(mergeBase, head)) {
    if (!commentSyntax(file.path)) continue;
    const added = addedLines(mergeBase, head, file.path);
    const kind = isTestPath(file.path) ? "test" : "source";
    try {
      const after = measureFile(show(head, file.path), file.path);
      const counted = countComments({ path: file.path, added, docstringLines: new Set(after.docstrings) });
      density[kind].added += counted.added;
      density[kind].comments += counted.comments;
      if (kind === "source") commentLines.push(...counted.lines.map((line) => `${file.path}:${line}`));
      if (kind === "source" && after.functions.length) {
        const before = file.added ? [] : measureFile(show(mergeBase, file.before), file.before).functions;
        flags.push(...complexityFlags({ path: file.path, before, after: after.functions, addedLines: [...added.keys()] }));
      }
    } catch (error) {
      unparsed.push(`${file.path}: ${error.message.split("\n")[0]}`);
    }
  }
  return { mergeBase, density, commentLines, flags, unparsed };
}

function conflictsWith(ref, head) {
  const merged = spawnSync("git", ["merge-tree", "--write-tree", "--name-only", "--no-messages", ref, head], { encoding: "utf8" });
  if (merged.status > 1) throw new Error(`git merge-tree ${ref} ${head}: ${merged.stderr.trim()}`);
  return merged.status === 1 ? parseMergeTree(merged.stdout) : [];
}

function mergeabilityFacts({ base, head, mergeBase, baseRef, defaultBranch }) {
  const stacked = isStacked({ baseRef, defaultBranch });
  const baseConflicts = conflictsWith(base, head);
  const defaultConflicts = stacked && !baseConflicts.length ? conflictsWith(`origin/${defaultBranch}`, head) : [];
  const addedPaths = changedFiles(mergeBase, head).filter((file) => file.added).map((file) => file.path);
  return {
    stacked,
    baseRef,
    behindBase: Number(git("rev-list", "--count", `${head}..${base}`).trim()),
    conflicts: baseConflicts.length ? baseConflicts : defaultConflicts,
    conflictTarget: baseConflicts.length ? baseRef : defaultBranch,
    size: measureSize(git("diff", "--numstat", mergeBase, head)),
    migrationHazards: migrationHazards({ addedPaths, basePaths: [base, `origin/${defaultBranch}`].flatMap((ref) => git("ls-tree", "-r", "--name-only", ref).split("\n")) }),
  };
}

const env = process.env;
const result = collect(env.BASE_SHA, env.HEAD_SHA);
const scorecard = {
  ...result,
  mergeability: mergeabilityFacts({ base: env.BASE_SHA, head: env.HEAD_SHA, mergeBase: result.mergeBase, baseRef: env.BASE_REF, defaultBranch: env.DEFAULT_BRANCH }),
  metrics: [
    { name: "Clean code", ...scoreCleanCode(result.density.source) },
    { name: "Complexity", ...scoreComplexity(result.flags) },
  ],
};
const path = join(env.RUNNER_TEMP ?? ".", "scorecard.json");
await writeFile(path, JSON.stringify(scorecard, null, 2));
if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `path=${path}\n`);
console.log(JSON.stringify(scorecard.metrics, null, 2));
