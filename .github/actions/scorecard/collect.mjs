import { execFileSync } from "node:child_process";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commentSyntax, complexityFlags, countComments, isTestPath, scoreCleanCode, scoreComplexity } from "./metrics.mjs";
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

const result = collect(process.env.BASE_SHA, process.env.HEAD_SHA);
const scorecard = {
  ...result,
  metrics: [
    { name: "Clean code", ...scoreCleanCode(result.density.source) },
    { name: "Complexity", ...scoreComplexity(result.flags) },
  ],
};
const path = join(process.env.RUNNER_TEMP ?? ".", "scorecard.json");
await writeFile(path, JSON.stringify(scorecard, null, 2));
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `path=${path}\n`);
console.log(JSON.stringify(scorecard.metrics, null, 2));
