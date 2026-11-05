import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { repo as makeRepo } from './repo-fixture.mjs';
import { explained, testsRemovedEntries } from './test-integrity.mjs';
import { writeFileSync } from 'node:fs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'test-integrity.mjs');
const repo = (files) => makeRepo(CLI, files);

function check(r, body = '') {
  const file = join(r.dir, '.git', 'pr-body.md');
  writeFileSync(file, body);
  return r.check('--base', 'main', '--body-file', file);
}

const spec = (...lines) => [...lines, ''].join('\n');

test('a new skip needs a quarantine issue', () => {
  const r = repo({ 'a.spec.ts': spec("it('a', () => expect(1).toBe(1));") });
  r.commit({ 'a.spec.ts': spec("it('a', () => expect(1).toBe(1));", "it.skip('b', () => expect(2).toBe(2));") });
  const res = check(r);
  assert.equal(res.code, 1);
  assert.match(res.out, /a\.spec\.ts:2 A skipped test needs a tracking issue/);

  r.commit({
    'a.spec.ts': spec("it('a', () => expect(1).toBe(1));", '// quarantine: #42 the upstream mock server times out', "it.skip('b', () => expect(2).toBe(2));"),
  });
  assert.equal(check(r).code, 0);
});

test('focus markers always fail', () => {
  const r = repo({ 'a.test.tsx': spec("it('a', () => expect(1).toBe(1));") });
  r.commit({ 'a.test.tsx': spec('// quarantine: #42 debugging', "it.only('a', () => expect(1).toBe(1));", "fdescribe('b', () => {});") });
  const res = check(r);
  assert.equal((res.out.match(/focus marker/g) ?? []).length, 2);
});

test('environment gates and computed skips are allowed', () => {
  const r = repo({ 'a.spec.ts': spec("it('a', () => expect(1).toBe(1));") });
  r.commit({
    'a.spec.ts': spec(
      'const d = process.env.DATABASE_URL ? describe : describe.skip;',
      "d('db', () => {});",
      "test.skip(!process.env.HEALTH, 'the backend is not reachable');",
      "test('win', { skip: process.platform === 'win32' }, () => {});",
      "it('a', () => expect(1).toBe(1));",
    ),
  });
  assert.equal(check(r).code, 0, check(r).out);
});

test('node:test skip options with literal values count as skips', () => {
  const r = repo({ 'a.test.mjs': spec("test('a', () => {});") });
  r.commit({ 'a.test.mjs': spec("test('a', () => {});", "test('b', { skip: true }, () => {});", "test('c', { todo: 'later' }, () => {});") });
  assert.equal((check(r).out.match(/needs a tracking issue/g) ?? []).length, 2);
});

test('skips already on the base branch are not reported again', () => {
  const r = repo({ 'a.spec.ts': spec("it.skip('old', () => {});") });
  r.commit({ 'a.spec.ts': spec("it.skip('old', () => {});", "it('new', () => expect(1).toBe(1));") });
  assert.equal(check(r).code, 0);
});

test('removing assertions alongside a source change needs a reason in the description', () => {
  const r = repo({
    'src/a.ts': 'export const a = 1;\n',
    'a.spec.ts': spec("it('a', () => { expect(1).toBe(1); expect(2).toBe(2); });"),
    'old.spec.ts': spec("it('old', () => expect(1).toBe(1));"),
  });
  r.commit({ 'src/a.ts': 'export const a = 2;\n', 'a.spec.ts': spec("it('a', () => { expect(1).toBe(1); });"), 'old.spec.ts': null });
  let res = check(r);
  assert.equal(res.code, 1);
  assert.match(res.out, /a\.spec\.ts \(2 -> 1 assertions\)/);
  assert.match(res.out, /old\.spec\.ts \(deleted\)/);

  res = check(r, '## Tests removed\n- a.spec.ts: too short\n- old.spec.ts: deleted because it only asserted the mock it set up.\n');
  assert.match(res.out, /a\.spec\.ts \(2 -> 1/);
  assert.doesNotMatch(res.out, /old\.spec\.ts/);

  res = check(
    r,
    '## Description\nx\n\n### Tests removed\n- `a.spec.ts` (2 -> 1 assertions): the second check repeated the first\n  with another literal.\n- old.spec.ts: deleted because it only asserted the mock it set up.\n\n## Related\n',
  );
  assert.equal(res.code, 0, res.out);
});

test('renaming a test file to a non-test name counts as deleting it', () => {
  const body = spec("it('old', () => { expect(1).toBe(1); expect(2).toBe(2); });");
  const r = repo({ 'src/a.ts': 'export const a = 1;\n', 'old.spec.ts': body, 'keep.spec.ts': body });
  r.commit({ 'src/a.ts': 'export const a = 2;\n', 'old.spec.ts': null, 'old.fixture.ts': body, 'keep.spec.ts': null, 'kept.spec.ts': body });
  let res = check(r);
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /old\.spec\.ts \(deleted\)/);
  assert.doesNotMatch(res.out, /keep/);

  res = check(r, '## Tests removed\n- old.spec.ts: moved to a fixture because nothing ran it anymore.\n');
  assert.equal(res.code, 0, res.out);
});

test('a change to tests alone may delete tests without a reason', () => {
  const r = repo({ 'old.spec.ts': spec("it('old', () => expect(1).toBe(1));"), 'a.spec.ts': spec("it('a', () => expect(1).toBe(1));") });
  r.commit({ 'old.spec.ts': null, 'a.spec.ts': spec("it('a', () => {});") });
  assert.equal(check(r).code, 0);
});

test('python: skip decorators, guarded skips and assertion counts', () => {
  const r = repo({
    'pkg/m.py': 'X = 1\n',
    'tests/test_m.py': spec('import pytest', 'def test_a():', '    assert 1 == 1', '    assert 2 == 2'),
  });
  r.commit({
    'pkg/m.py': 'X = 2\n',
    'tests/test_m.py': spec(
      'import pytest, sys',
      '@pytest.mark.skip(reason="flaky")',
      'def test_a():',
      '    assert 1 == 1',
      '@pytest.mark.skipif(sys.platform == "win32", reason="posix only")',
      'def test_b():',
      '    if not sys.stdin:',
      '        pytest.skip("no stdin")',
      '    assert True',
      '# quarantine: #9 the vendor sandbox is down',
      '@pytest.mark.skip(reason="vendor")',
      'def test_c():',
      '    pass',
    ),
  });
  const out = check(r).out;
  assert.match(out, /tests\/test_m\.py:2 A skipped test/);
  assert.doesNotMatch(out, /tests\/test_m\.py:(5|8|11) /);
  assert.doesNotMatch(out, /assertions/);
});

test('parses the Tests removed section', () => {
  const entries = testsRemovedEntries('## Tests removed\n<!-- hint -->\n- one path: reason\n  continued here\n* two\n## Next\n- not this');
  assert.deepEqual(entries, ['- one path: reason continued here', '* two']);
  assert.equal(explained('a/b.spec.ts', ['- a/b.spec.ts (9 -> 3 assertions): duplicate rows of the same branch']), true);
  assert.equal(explained('a/b.spec.ts', ['- a/b.spec.ts: duplicate rows']), false);
});
