import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MARKER, merge, readReports, render } from './comment.mjs';
import { parseRanges } from './ranges.mjs';
import { shard } from './shard.mjs';

test('parseRanges keeps added hunks and drops deletion-only hunks', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -3,0 +4,2 @@ fn',
    '@@ -10,3 +11,0 @@',
    '@@ -20 +20 @@',
    '-old',
    '+++ added line that looks like a header',
    'diff --git a/src/new.ts b/src/new.ts',
    '--- /dev/null',
    '+++ b/src/new.ts',
    '@@ -0,0 +1,7 @@',
  ].join('\n');
  assert.deepEqual(parseRanges(diff), ['src/a.ts:4-5', 'src/a.ts:20-20', 'src/new.ts:1-7']);
});

const mutant = (status, line, replacement = 'x') => ({
  status,
  mutatorName: 'EqualityOperator',
  replacement,
  location: { start: { line, column: 1 }, end: { line, column: 2 } },
});

test('render counts statuses and scores detected over valid mutants', () => {
  const report = {
    files: {
      '/repo/src/b.ts': { mutants: [mutant('Killed', 1), mutant('Timeout', 2), mutant('Survived', 9, 'a <\n b')] },
      'src/a.ts': { mutants: [mutant('NoCoverage', 3), mutant('CompileError', 4), mutant('Survived', 7)] },
    },
  };
  const body = render(report, { cwd: '/repo', runUrl: 'https://run' });
  assert.ok(body.startsWith(MARKER));
  assert.match(body, /\| 40\.0% \| 1 \| 2 \| 1 \| 1 \| 1 \|/);
  assert.match(body, /- `src\/a\.ts:7` EqualityOperator <code>x<\/code>\n- `src\/b\.ts:9` EqualityOperator <code>a &lt; b<\/code>/);
  assert.match(body, /\[Run log\]\(https:\/\/run\)$/);
});

test('render lists at most 20 survivors', () => {
  const mutants = Array.from({ length: 25 }, (_, i) => mutant('Survived', i + 1));
  const body = render({ files: { 'src/a.ts': { mutants } } });
  assert.match(body, /first 20 of 25/);
  assert.equal(body.split('\n').filter((l) => l.startsWith('- ')).length, 20);
});

test('render says so when Stryker wrote no report', () => {
  assert.match(render(null), /did not produce a report/);
});

test('the reusable workflow checks out PR code without persisting the write-scoped token', () => {
  const wf = readFileSync(new URL('../../workflows/reusable-mutation-report.yml', import.meta.url), 'utf8');
  const checkouts = wf.split(/\n\s*- /).filter((step) => /uses: actions\/checkout@/.test(step));
  assert.ok(checkouts.length > 0);
  for (const step of checkouts) assert.match(step, /persist-credentials: false/);
});

test('shard returns no shards when nothing is in scope', () => {
  assert.deepEqual(shard('', 4), []);
});

test('shard keeps small diffs on one runner', () => {
  const out = shard('src/a.ts:1-10,src/b.ts:5-20', 4);
  assert.equal(out.length, 1);
  assert.equal(out[0].mutate, 'src/a.ts:1-10,src/b.ts:5-20');
  assert.equal(out[0].lines, 26);
});

test('shard spreads large diffs across at most the requested runners without splitting or dropping ranges', () => {
  const ranges = ['src/a.ts:1-200', 'src/b.ts:1-150', 'src/c.ts:1-120', 'src/a.ts:300-339', 'src/d.ts:7-7', 'src/e.ts:1-90'];
  const out = shard(ranges.join(','), 3);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((s) => s.index), [0, 1, 2]);
  const all = out.flatMap((s) => s.mutate.split(','));
  assert.deepEqual([...all].sort(), [...ranges].sort());
  const lines = out.map((s) => s.lines);
  assert.equal(lines.reduce((a, b) => a + b), 601);
  assert.ok(Math.max(...lines) - Math.min(...lines) <= 50);
});

test('shard never makes more shards than ranges', () => {
  assert.equal(shard('src/a.ts:1-900', 4).length, 1);
});

test('merge unions shard reports and keeps every mutant', () => {
  const a = { schemaVersion: '1', files: { 'src/a.ts': { language: 'typescript', mutants: [mutant('Killed', 1)] } } };
  const b = {
    schemaVersion: '1',
    files: {
      'src/a.ts': { language: 'typescript', mutants: [mutant('Survived', 9)] },
      'src/b.ts': { language: 'typescript', mutants: [mutant('Timeout', 2)] },
    },
  };
  const merged = merge([a, null, b]);
  assert.equal(merged.files['src/a.ts'].mutants.length, 2);
  assert.equal(merged.files['src/b.ts'].mutants.length, 1);
  assert.equal(a.files['src/a.ts'].mutants.length, 1);
  assert.equal(merge([]), null);
});

test('readReports reads every shard report under a directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mutation-'));
  for (const i of [0, 1]) {
    mkdirSync(join(dir, `mutation-report-${i}`));
    writeFileSync(join(dir, `mutation-report-${i}`, 'mutation.json'), JSON.stringify({ files: { [`src/${i}.ts`]: { mutants: [] } } }));
  }
  assert.equal(readReports(dir).length, 2);
  assert.deepEqual(readReports(join(dir, 'absent')), []);
});

test('render calls out shards that produced no report', () => {
  const body = render({ files: { 'src/a.ts': { mutants: [mutant('Killed', 1)] } } }, { missing: 1, expected: 3 });
  assert.match(body, /1 of 3 shards produced no report/);
  assert.doesNotMatch(render({ files: {} }), /shards produced no report/);
});
