import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MARKER, render } from './comment.mjs';
import { parseRanges } from './ranges.mjs';

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
