import { execFileSync, spawnSync } from "node:child_process";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commentSyntax, complexityFlags, countComments, isTestPath, scoreCleanCode, scoreComplexity } from "./metrics.mjs";
import { isStacked, measureSize, migrationHazards, parseMergeTree } from "./mergeability.mjs";
import { lineSignals, loopAwaitSignals, scorePerformance } from "./performance.mjs";
import { concurrentIndexNames, hygieneFindings, lockingFindings, undocumentedEnv } from "./production.mjs";
import { measureScript } from "./script_complexity.mjs";
import { awaitsInLoops } from "./script_signals.mjs";

const SCRIPT = /\.(c|m)?[jt]sx?$/;
const PYTHON = /\.py$/;
const MIGRATION_SQL = /(^|\/)migrations\/.+\.sql$/;
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const env = process.env;

function changedFiles(base, head) {
  return git("diff", "--name-status", "--find-renames", base, head)
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .filter(([status]) => !status.startsWith("D"))
    .map((parts) => ({ before: parts[1], path: parts.at(-1), isNew: parts[0] === "A" }));
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

function exists(commit, path) {
  return spawnSync("git", ["cat-file", "-e", `${commit}:${path}`]).status === 0;
}

function show(commit, path) {
  return exists(commit, path) ? git("show", `${commit}:${path}`) : "";
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

function measureChange(file, mergeBase) {
  const after = measureFile(file.code, file.path);
  const counted = countComments({ path: file.path, added: file.added, docstringLines: new Set(after.docstrings) });
  if (file.kind === "test") return { counted, flags: [], signals: [] };
  const before = file.isNew ? [] : measureFile(show(mergeBase, file.before), file.before).functions;
  const flags = complexityFlags({ path: file.path, before, after: after.functions, addedLines: [...file.added.keys()] });
  const awaits = SCRIPT.test(file.path) ? awaitsInLoops(file.code, file.path) : [];
  const signals = [...lineSignals(file), ...loopAwaitSignals({ path: file.path, awaits, added: file.added })];
  return { counted, flags, signals };
}

function measureCode(files, mergeBase) {
  const density = { source: { added: 0, comments: 0 }, test: { added: 0, comments: 0 } };
  const result = { density, commentLines: [], flags: [], signals: [], unparsed: [] };
  for (const file of files.filter((candidate) => commentSyntax(candidate.path))) {
    try {
      const { counted, flags, signals } = measureChange(file, mergeBase);
      density[file.kind].added += counted.added;
      density[file.kind].comments += counted.comments;
      if (file.kind === "source") result.commentLines.push(...counted.lines.map((line) => `${file.path}:${line}`));
      result.flags.push(...flags);
      result.signals.push(...signals);
    } catch (error) {
      result.unparsed.push(`${file.path}: ${error.message.split("\n")[0]}`);
    }
  }
  return result;
}

function conflictsWith(ref, head) {
  const merged = spawnSync("git", ["merge-tree", "--write-tree", "--name-only", "--no-messages", ref, head], { encoding: "utf8" });
  if (merged.status > 1) throw new Error(`git merge-tree ${ref} ${head}: ${merged.stderr.trim()}`);
  return merged.status === 1 ? parseMergeTree(merged.stdout) : [];
}

function mergeabilityFacts({ files, base, head, mergeBase, baseRef, defaultBranch }) {
  const stacked = isStacked({ baseRef, defaultBranch });
  const baseConflicts = conflictsWith(base, head);
  const defaultConflicts = stacked && !baseConflicts.length ? conflictsWith(`origin/${defaultBranch}`, head) : [];
  const basePaths = [base, `origin/${defaultBranch}`].flatMap((ref) => git("ls-tree", "-r", "--name-only", ref).split("\n"));
  return {
    stacked,
    baseRef,
    behindBase: Number(git("rev-list", "--count", `${head}..${base}`).trim()),
    conflicts: baseConflicts.length ? baseConflicts : defaultConflicts,
    conflictTarget: baseConflicts.length ? baseRef : defaultBranch,
    size: measureSize(git("diff", "--numstat", mergeBase, head)),
    migrationHazards: migrationHazards({ addedPaths: files.filter((file) => file.isNew).map((file) => file.path), basePaths }),
  };
}

async function squawk(migrations) {
  if (!migrations.length) return [];
  const dir = await mkdtemp(join(env.RUNNER_TEMP ?? "/tmp", "squawk-"));
  const paths = await Promise.all(migrations.map(async (file, index) => {
    const path = join(dir, `${index}.sql`);
    await writeFile(path, file.code);
    return path;
  }));
  const run = spawnSync("squawk", ["--reporter", "json", ...paths], { encoding: "utf8" });
  if (!run.stdout.trim()) throw new Error(`squawk failed: ${run.stderr.trim()}`);
  const byTemp = new Map(paths.map((path, index) => [path, migrations[index].path]));
  return JSON.parse(run.stdout).map((finding) => ({ ...finding, file: byTemp.get(finding.file) ?? finding.file }));
}

function concurrentIndexes(head) {
  const grep = spawnSync("git", ["grep", "-h", "-i", "-E", "create (unique )?index concurrently", head, "--", "*.sh", "*.sql"], { encoding: "utf8" });
  return concurrentIndexNames(grep.stdout);
}

async function productionFacts({ files, head, body }) {
  const migrations = files.filter((file) => file.isNew && MIGRATION_SQL.test(file.path));
  const source = files.filter((file) => file.kind === "source");
  return {
    lockingMigrations: lockingFindings({
      findings: await squawk(migrations),
      sqlLines: new Map(migrations.map((file) => [file.path, file.code.split("\n")])),
      concurrentIndexes: concurrentIndexes(head),
    }),
    undocumentedEnv: undocumentedEnv({
      addedSource: source.flatMap((file) => [...file.added.values()]),
      envExample: exists(head, ".env.example") ? show(head, ".env.example") : null,
    }),
    hygiene: hygieneFindings({ body, changedPaths: source.map((file) => file.path) }),
  };
}

async function pullRequestBody() {
  if (!env.GITHUB_EVENT_PATH) return "";
  return JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8")).pull_request?.body ?? "";
}

const [base, head] = [env.BASE_SHA, env.HEAD_SHA];
const mergeBase = git("merge-base", base, head).trim();
const files = changedFiles(mergeBase, head).map((file) => ({
  ...file,
  kind: isTestPath(file.path) ? "test" : "source",
  added: addedLines(mergeBase, head, file.path),
  code: show(head, file.path),
}));
const code = measureCode(files, mergeBase);
const scorecard = {
  mergeBase,
  ...code,
  mergeability: mergeabilityFacts({ files, base, head, mergeBase, baseRef: env.BASE_REF, defaultBranch: env.DEFAULT_BRANCH }),
  production: await productionFacts({ files, head, body: await pullRequestBody() }),
  metrics: [
    { name: "Clean code", ...scoreCleanCode(code.density.source) },
    { name: "Performance", ...scorePerformance(code.signals) },
    { name: "Complexity", ...scoreComplexity(code.flags) },
  ],
};
const path = join(env.RUNNER_TEMP ?? ".", "scorecard.json");
await writeFile(path, JSON.stringify(scorecard, null, 2));
if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `path=${path}\n`);
console.log(JSON.stringify(scorecard.metrics, null, 2));
