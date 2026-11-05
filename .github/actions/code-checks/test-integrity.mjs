#!/usr/bin/env node
// Run inside the repo to check: test-integrity.mjs --base <rev> --body-file <pr-body.md>
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inScope, isCode, isPython, isTestFile } from './lib/files.mjs';
import { changedFiles, mergeBase, repoRoot, showAt } from './lib/git.mjs';
import { analyzeTs } from './lib/test-sites.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIN_REASON_WORDS = 5;

function analyzeAll(items) {
  const out = new Map();
  const py = items.filter((i) => isPython(i.path));
  for (const i of items.filter((i) => !isPython(i.path))) out.set(i.key, analyzeTs(i.path, i.text));
  if (py.length) {
    const res = JSON.parse(
      execFileSync('python3', ['-I', join(HERE, 'lib', 'py_tests.py')], {
        input: JSON.stringify(py.map(({ key, text }) => ({ key, text }))),
        maxBuffer: 1 << 28,
      }),
    );
    for (const [key, value] of Object.entries(res)) out.set(key, value);
  }
  return out;
}

// Bullets under a "Tests removed" heading, each one a single string.
export function testsRemovedEntries(body) {
  const lines = body.replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const start = lines.findIndex((l) => /^#{1,6}\s*tests removed\b/i.test(l.trim()));
  if (start === -1) return [];
  const entries = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line.trim())) break;
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) entries.push(line.trim());
    else if (entries.length && line.trim()) entries[entries.length - 1] += ` ${line.trim()}`;
  }
  return entries;
}

export function explained(path, entries) {
  return entries.some((e) => {
    if (!e.includes(path)) return false;
    const rest = e.replace(path, ' ').replace(/`/g, ' ').replace(/\([^)]*\)/g, ' ');
    return (rest.match(/[A-Za-z]{2,}/g) ?? []).length >= MIN_REASON_WORDS;
  });
}

const multiset = (keys) => {
  const m = new Map();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
};

// Sites in `head` that `base` does not already have, matched by kind and line text.
function newSites(base, head) {
  const left = multiset(base.map((s) => s.key));
  return head.filter((s) => {
    const n = left.get(s.key) ?? 0;
    if (n > 0) {
      left.set(s.key, n - 1);
      return false;
    }
    return true;
  });
}

export function check({ base, body }) {
  const mb = mergeBase(base);
  const changes = changedFiles(mb);
  const sourceChanged = changes.some((c) =>
    [c.from, c.to].some((p) => isCode(p) && !isTestFile(p) && inScope(p)),
  );

  const items = [];
  for (const c of changes) {
    if (c.status === 'D' || !isTestFile(c.to)) continue;
    const before = c.status === 'A' ? '' : (showAt(mb, c.from) ?? '');
    items.push({ key: `base:${c.to}`, path: c.to, text: before });
    items.push({ key: `head:${c.to}`, path: c.to, text: readFileSync(c.to, 'utf8') });
  }
  const results = analyzeAll(items);

  const problems = [];
  const needsReason = [];
  for (const c of changes) {
    if (isTestFile(c.from) && (c.status === 'D' || !isTestFile(c.to))) {
      needsReason.push({ path: c.from, what: 'deleted' });
      continue;
    }
    if (c.status === 'D' || !isTestFile(c.to)) continue;
    const before = results.get(`base:${c.to}`);
    const after = results.get(`head:${c.to}`);
    for (const s of newSites(before.sites, after.sites)) {
      if (s.kind === 'focus') {
        problems.push({ path: c.to, line: s.line, message: 'Remove the focus marker (.only, fit, fdescribe); it silently turns off every other test in the file.' });
      } else if (!s.quarantined) {
        problems.push({ path: c.to, line: s.line, message: 'A skipped test needs a tracking issue in the comment above it: `// quarantine: #1234 <why>`.' });
      }
    }
    if (after.asserts < before.asserts) {
      needsReason.push({ path: c.to, what: `${before.asserts} -> ${after.asserts} assertions` });
    }
  }

  if (sourceChanged) {
    const entries = testsRemovedEntries(body);
    for (const n of needsReason) {
      if (explained(n.path, entries)) continue;
      problems.push({
        path: n.path,
        line: 1,
        message: `This change also edits source code, so the PR description needs a "## Tests removed" section with a bullet naming ${n.path} (${n.what}) and why, in at least ${MIN_REASON_WORDS} words.`,
      });
    }
  }
  return { problems, needsReason, sourceChanged };
}

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : argv[i + 1];
  };
  const base = arg('--base');
  if (!base) {
    console.error('Pass --base <rev> and optionally --body-file <path>.');
    return 2;
  }
  const bodyFile = arg('--body-file');
  const body = bodyFile ? readFileSync(bodyFile, 'utf8') : '';
  process.chdir(repoRoot());
  const { problems } = check({ base, body });
  for (const p of problems) {
    console.log(`${p.path}:${p.line} ${p.message}`);
    if (process.env.GITHUB_ACTIONS) console.log(`::error file=${p.path},line=${p.line},title=test integrity::${p.message}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        `### Test integrity ${problems.length ? ':x:' : ':white_check_mark:'}`,
        '',
        ...(problems.length ? problems.map((p) => `- \`${p.path}:${p.line}\` ${p.message}`) : ['No new skips, focus markers or unexplained test removals.']),
        '',
        'Editing the PR description runs this check again.',
        '',
      ].join('\n'),
    );
  }
  if (!problems.length) console.log('Test integrity passed.');
  return problems.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
