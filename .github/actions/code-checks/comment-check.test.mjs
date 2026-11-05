import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'comment-check.mjs');

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'comment-check-'));
  const run = (...args) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
      cwd: dir,
      stdio: 'pipe',
    });
  const write = (entries) => {
    for (const [path, text] of Object.entries(entries)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  };
  run('init', '-q', '-b', 'main');
  write(files);
  run('add', '-A');
  run('commit', '-q', '-m', 'base');
  run('checkout', '-q', '-b', 'change');
  return {
    dir,
    commit(entries) {
      write(entries);
      run('add', '-A');
      run('commit', '-q', '-m', 'change');
    },
    check(...args) {
      const r = spawnSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH } });
      return { code: r.status, out: r.stdout + r.stderr };
    },
  };
}

const count = (r) => Number(r.check('--count').out.trim());
const rules = (out) => out.split('\n').filter((l) => /^\S+:\d+ /.test(l)).map((l) => l.split(' ')[1].replace(/:$/, ''));

test('flags each rule on new comments and leaves fine ones alone', () => {
  const r = repo({ 'a.ts': 'export const a = 1;\n' });
  r.commit({
    'a.ts': [
      "export const a = 1;",
      "// ---------------------------------",
      "console.log(0);",
      "// Fixed in #1234.",
      "console.log(1);",
      "// Decided in D85 for the C1 train.",
      "console.log(2);",
      "// We previously, cached this.",
      "console.log(3);",
      "// {",
      "//   label: 'SOC 2',",
      "// },",
      "console.log(4);",
      "/**",
      " * one",
      " * two",
      " * three",
      " * four",
      " * five",
      " */",
      "console.log(5);",
      "// eslint-disable-next-line no-console",
      "console.log(6);",
      "// TODO make this faster",
      "console.log(7);",
      "// tab=9 is out of range, so it falls back to 0.",
      "console.log(8);",
      "// The \"Skip for now\" button keeps the draft.",
      "console.log(9);",
      "// regression: #77 keeps the empty-list case.",
      "console.log(10);",
      "// TODO(#88): drop once the API returns ids.",
      "console.log(11);",
      "// eslint-disable-next-line no-console -- the CLI prints to stdout on purpose",
      "console.log(12);",
      '',
    ].join('\n'),
  });
  const res = r.check('--base', 'main', '--no-ceiling');
  assert.deepEqual(rules(res.out).sort(), [
    'banner',
    'block-over-4-lines',
    'commented-out-code',
    'history-phrase',
    'history-ref',
    'plan-label',
    'suppression-without-reason',
    'todo-without-link',
  ]);
});

test('counts JSX comments and block lines without a leading star', () => {
  const r = repo({
    'v.tsx': [
      'export const V = () => (',
      '  <div>',
      '    {/* a JSX comment */}',
      '    <span />',
      '  </div>',
      ');',
      '/*',
      '  no star here',
      '*/',
      "const s = '// not a comment';",
      '',
    ].join('\n'),
  });
  assert.equal(count(r), 4);
});

test('only lines the change adds are checked', () => {
  const r = repo({ 'a.ts': '// Fixed in #1234.\nexport const a = 1;\n', '.github/comment-ceiling.json': '{"commentLines": 1}\n' });
  r.commit({ 'a.ts': '// Fixed in #1234.\nexport const a = 2;\n' });
  const res = r.check('--base', 'main');
  assert.equal(res.code, 0, res.out);
});

test('the ceiling fails on growth, passes with a notice on shrinkage, and never rises', () => {
  const r = repo({ 'a.ts': '// keeps the cache warm\nexport const a = 1;\n', '.github/comment-ceiling.json': '{"commentLines": 1}\n' });
  r.commit({ 'a.ts': '// keeps the cache warm\n// and the retry bounded\nexport const a = 1;\n' });
  let res = r.check('--base', 'HEAD^');
  assert.equal(res.code, 1);
  assert.match(res.out, /1 over the ceiling of 1/);

  r.commit({ 'a.ts': 'export const a = 1;\n' });
  res = r.check('--base', 'HEAD^');
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /can go down to 0/);

  r.commit({ '.github/comment-ceiling.json': '{"commentLines": 0}\n' });
  assert.equal(r.check('--base', 'HEAD^').code, 0);

  r.commit({ 'a.ts': '// keeps the cache warm\nexport const a = 1;\n', '.github/comment-ceiling.json': '{"commentLines": 1}\n' });
  res = r.check('--base', 'HEAD^');
  assert.equal(res.code, 1);
  assert.match(res.out, /may only go down/);
});

test('a missing ceiling file names the number to commit', () => {
  const r = repo({ 'a.ts': '// keeps the cache warm\nexport const a = 1;\n' });
  r.commit({ 'b.ts': 'export const b = 1;\n' });
  const res = r.check('--base', 'main');
  assert.equal(res.code, 1);
  assert.match(res.out, /\{"commentLines": 1\}/);
});

test('a change cannot exclude its own files', () => {
  const r = repo({ 'a.ts': 'export const a = 1;\n' });
  r.commit({ '.github/comment-check.json': '{"exclude": ["a.ts"]}\n', 'a.ts': '// Fixed in #1234.\nexport const a = 1;\n' });
  assert.deepEqual(rules(r.check('--base', 'main', '--no-ceiling').out), ['history-ref']);
});

test('python: comments, docstrings, suppressions and commented-out code', () => {
  const r = repo({ 'm.py': 'X = 1\n' });
  r.commit({
    'm.py': [
      '"""Module doc."""',
      'import os  # noqa: F401',
      'import sys  # noqa: F401 kept for the plugin loader',
      '# result = compute(x)',
      '# return result',
      'Y = 2',
      'X = 1  # type: ignore',
      '',
    ].join('\n'),
  });
  const res = r.check('--base', 'main', '--no-ceiling');
  assert.deepEqual(rules(res.out).sort(), ['commented-out-code', 'suppression-without-reason', 'suppression-without-reason']);
  assert.equal(count(r), 3);
});

test('files with a line over 2000 characters are still checked and counted', () => {
  const long = `export const blob = '${'x'.repeat(2500)}';`;
  const r = repo({ 'a.ts': 'export const a = 1;\n', 'm.py': 'X = 1\n' });
  r.commit({
    'a.ts': `${long}\n// Fixed in #1234.\nexport const a = 1;\n`,
    'm.py': `B = '${'x'.repeat(2500)}'\n# Fixed in #1234.\nX = 1\n`,
  });
  assert.deepEqual(rules(r.check('--base', 'main', '--no-ceiling').out), ['history-ref', 'history-ref']);
  assert.equal(count(r), 2);
});

test('rationale wording fails while decision and plan as domain words pass', () => {
  const r = repo({ 'a.ts': 'export const a = 1;\n' });
  const domain = [
    '// Records the decision to the OPA decision log.',
    '// Resolve orgId from the plan or the membership.',
    '// Try an action that is not in the plan.',
    '// Shows who made the decision and why.',
  ];
  const rationale = [
    '// This was a design decision for the first release.',
    '// The decision was to keep the cache local.',
    '// Matches the payload per the plan.',
    '// The plan says to retry once.',
    '// We deviate from the spec here.',
    '// A judgement call on the timeout.',
    '// First cut of the parser.',
    '// See PRD §8.4.',
  ];
  const lines = ['export const a = 1;'];
  for (const c of [...domain, ...rationale]) lines.push(c, 'console.log(a);');
  r.commit({ 'a.ts': `${lines.join('\n')}\n` });
  const out = r.check('--base', 'main', '--no-ceiling').out;
  const flagged = out.split('\n').filter((l) => / history-phrase:/.test(l)).map((l) => Number.parseInt(l.split(':')[1], 10));
  const lineOf = (c) => lines.indexOf(c) + 1;
  assert.deepEqual(flagged, rationale.map(lineOf), out);
});

test('doc comments on the public API may run past four lines', () => {
  const long = (indent) => ['"""Line one.', 'two', 'three', 'four', 'five', '"""'].map((l, i) => (i ? indent : '') + l).join('\n');
  const jsDoc = '/**\n * one\n * two\n * three\n * four\n * five\n */\n';
  const r = repo({
    '.github/comment-check.json': '{"publicApi": ["src/index.ts", "pkg/__init__.py"]}\n',
    'src/index.ts': "export { Client } from './client';\n",
    'src/client.ts': 'export class Client {}\n',
    'src/internal.ts': 'export const x = 1;\n',
    'pkg/__init__.py': 'from .client import Client\n\n__all__ = ["Client"]\n',
    'pkg/client.py': 'class Client:\n    pass\n',
  });
  r.commit({
    'src/client.ts': `${jsDoc}export class Client {\n  ${jsDoc}  run() {}\n  ${jsDoc}  private hidden() {}\n}\n`,
    'src/internal.ts': `${jsDoc}export const x = 1;\n`,
    'pkg/client.py': `class Client:\n    ${long('    ')}\n\n    def run(self):\n        ${long('        ')}\n\n    def _hidden(self):\n        ${long('        ')}\n`,
  });
  const out = r.check('--base', 'main', '--no-ceiling').out;
  const flagged = out.split('\n').filter((l) => l.includes('block-over-4-lines')).map((l) => l.split(' ')[0]);
  assert.deepEqual(flagged.sort(), ['pkg/client.py:18', 'src/client.ts:17', 'src/internal.ts:1']);
});
