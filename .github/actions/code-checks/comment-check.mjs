#!/usr/bin/env node
// Run inside the repo to check. --base <rev>: rules on lines added since merge-base(<rev>, HEAD), plus the ceiling.
// --all: rules on every file. --count: print the comment-line total. --no-ceiling: skip the ceiling.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, inScope, isPython } from './lib/files.mjs';
import { addedRanges, mergeBase, repoRoot, showAt, trackedFiles } from './lib/git.mjs';
import { commentOnlyLines, comments, groups, looksLikeCode, parse } from './lib/js-comments.mjs';
import { MESSAGES, groupRules, jsSuppressionWithoutReason } from './lib/rules.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CEILING_FILE = '.github/comment-ceiling.json';
const CONFIG_FILE = '.github/comment-check.json';

function scanJs(root, path) {
  const text = readFileSync(join(root, path), 'utf8');
  const sf = parse(path, text);
  const list = comments(sf);
  const grouped = groups(list);
  const ownLineEnds = new Map(grouped.filter((g) => g.ownLine && !g.directive).map((g) => [g.endLine, g]));
  const violations = [];
  for (const g of grouped) {
    g.code = g.type === 'Line' && g.ownLine && !g.directive && looksLikeCode(g.rawLines);
    for (const rule of groupRules(g)) violations.push({ rule, line: g.startLine, end: g.endLine });
    for (const c of g.comments) {
      const directive = jsSuppressionWithoutReason(c.value);
      if (directive && !ownLineEnds.has(c.startLine - 1)) {
        violations.push({ rule: 'suppression-without-reason', line: c.startLine, end: c.endLine, directive });
      }
    }
  }
  return { path, commentLines: commentOnlyLines(text, list), violations };
}

function scanPython(root, paths) {
  if (paths.length === 0) return [];
  const out = execFileSync('python3', ['-I', join(HERE, 'lib', 'py_comments.py')], {
    input: JSON.stringify({ root, files: paths }),
    maxBuffer: 1 << 28,
  });
  return JSON.parse(out).map((f) => {
    const violations = [];
    for (const g of f.groups) {
      for (const rule of groupRules(g)) violations.push({ rule, line: g.startLine, end: g.endLine });
    }
    for (const s of f.suppressions) {
      violations.push({ rule: 'suppression-without-reason', line: s.line, end: s.line, directive: s.directive });
    }
    return { path: f.path, commentLines: f.commentLines, violations };
  });
}

export function scanRepo(root, config, onlyPaths = null) {
  const all = trackedFiles().filter((p) => inScope(p, config.exclude));
  const results = [];
  for (const path of all.filter((p) => !isPython(p))) results.push(scanJs(root, path));
  results.push(...scanPython(root, all.filter(isPython)));
  const total = results.reduce((n, r) => n + r.commentLines, 0);
  const scoped = onlyPaths ? results.filter((r) => onlyPaths.has(r.path)) : results;
  return { total, results: scoped };
}

function readCeiling(text) {
  if (text === null) return null;
  const value = JSON.parse(text).commentLines;
  return Number.isInteger(value) ? value : null;
}

function main(argv) {
  const root = repoRoot();
  process.chdir(root);
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : argv[i + 1];
  };
  const base = arg('--base');
  if (argv.includes('--count')) {
    const config = parseConfig(showAt('HEAD', CONFIG_FILE));
    console.log(scanRepo(root, config).total);
    return 0;
  }
  if (!base && !argv.includes('--all')) {
    console.error('Pass --base <rev>, --all or --count.');
    return 2;
  }
  const mb = base ? mergeBase(base) : null;
  // The config comes from the base so a pull request cannot exempt its own files.
  const config = parseConfig(showAt(mb ?? 'HEAD', CONFIG_FILE));
  const added = mb ? addedRanges(mb) : null;
  const { total, results } = scanRepo(root, config, added ? new Set(added.keys()) : null);

  const problems = [];
  for (const r of results) {
    for (const v of r.violations) {
      const ranges = added?.get(r.path);
      if (ranges && !ranges.some(([a, b]) => v.line <= b && v.end >= a)) continue;
      problems.push({ path: r.path, line: v.line, rule: v.rule, message: MESSAGES[v.rule] });
    }
  }

  const ceilingProblems = [];
  if (mb && !argv.includes('--no-ceiling')) {
    const ceiling = readCeiling(showAt('HEAD', CEILING_FILE));
    const baseCeiling = readCeiling(showAt(mb, CEILING_FILE));
    if (ceiling === null) {
      ceilingProblems.push(`Add ${CEILING_FILE} with {"commentLines": ${total}}.`);
    } else {
      if (baseCeiling !== null && ceiling > baseCeiling) {
        ceilingProblems.push(`The ceiling may only go down: ${CEILING_FILE} says ${ceiling}, the base says ${baseCeiling}.`);
      }
      if (total > ceiling) {
        ceilingProblems.push(`This change has ${total} comment lines, ${total - ceiling} over the ceiling of ${ceiling}. Remove ${total - ceiling} comment lines.`);
      } else if (total < ceiling) {
        ceilingProblems.push(`This change has ${total} comment lines, under the ceiling of ${ceiling}. Lower commentLines in ${CEILING_FILE} to ${total} in this change.`);
      }
    }
  }

  for (const p of problems) {
    console.log(`${p.path}:${p.line} ${p.rule}: ${p.message}`);
    if (process.env.GITHUB_ACTIONS) console.log(`::error file=${p.path},line=${p.line},title=${p.rule}::${p.message}`);
  }
  for (const c of ceilingProblems) {
    console.log(`ceiling: ${c}`);
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=comment ceiling::${c}`);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const byRule = {};
    for (const p of problems) byRule[p.rule] = (byRule[p.rule] ?? 0) + 1;
    const rows = Object.entries(byRule).map(([rule, n]) => `| ${rule} | ${n} |`);
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        `### Comment check ${problems.length + ceilingProblems.length ? ':x:' : ':white_check_mark:'}`,
        '',
        `Comment lines in the repo: **${total}**.`,
        ...ceilingProblems.map((c) => `- ${c}`),
        '',
        rows.length ? ['| rule | comments |', '|---|---:|', ...rows].join('\n') : 'No comment problems on the lines this change adds.',
        '',
      ].join('\n'),
    );
  }
  if (!problems.length && !ceilingProblems.length) console.log(`Comment check passed: ${total} comment lines.`);
  return problems.length || ceilingProblems.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
