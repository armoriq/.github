import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BROKEN_TITLE, flakyTitle, plan } from './issues.mjs';
import { main } from './main.mjs';
import { aggregate, legOf, mask, parseJestJson, parseJUnit, readResults, render } from './report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');
const brief = (results) => results.map(({ file, name, status }) => `${file} | ${name} | ${status}`);

describe('parsers read real runner output', () => {
  it('jest: assertions, skips, and a suite that never ran', () => {
    const r = parseJestJson(fixture('jest.json'));
    assert.deepEqual(brief(r), [
      '/home/runner/work/repo/repo/broken.test.js | (suite failed to run) | failed',
      '/home/runner/work/repo/repo/a.test.js | outer ok | passed',
      '/home/runner/work/repo/repo/a.test.js | outer bad | failed',
      '/home/runner/work/repo/repo/a.test.js | outer skip | skipped',
    ]);
    assert.match(r[0].message, /Cannot find module '.\/does-not-exist'/);
    assert.match(r[2].message, /toBe\(expected\)/);
  });

  it('vitest json', () => {
    assert.deepEqual(brief(parseJestJson(fixture('vitest.json'))), [
      '/home/runner/work/repo/repo/s.test.ts | outer ok | passed',
      '/home/runner/work/repo/repo/s.test.ts | outer bad | failed',
      '/home/runner/work/repo/repo/s.test.ts | outer skip | skipped',
    ]);
  });

  it('node:test junit, including a test outside any suite', () => {
    const r = parseJUnit(fixture('node-test.xml'));
    assert.deepEqual(brief(r), [
      '/home/runner/work/repo/repo/a.test.mjs | group › passes | passed',
      '/home/runner/work/repo/repo/a.test.mjs | group › fails | failed',
      '/home/runner/work/repo/repo/a.test.mjs | group › skipped | skipped',
      '/home/runner/work/repo/repo/a.test.mjs | top level | passed',
    ]);
    assert.match(r[1].message, /TestContext.<anonymous>/);
  });

  it('node:test junit with a raw > inside attribute values (real armorClaude output)', () => {
    const text = fixture('node20-raw-gt.xml');
    const r = parseJUnit(text);
    assert.equal(r.length, text.match(/<testcase\b/g).length);
    assert.deepEqual(r.map((t) => t.status), ['passed', 'passed', 'passed', 'passed', 'passed', 'failed']);
    assert.equal(r[1].name, 'every backend call from a armorclaude-dev-armoriq install names armorclaude-dev/<plugin version>');
    assert.equal(r[5].name, 'the live upload keeps its state and log owner-only');
    assert.match(r[5].message, /ENOTEMPTY: directory not empty/);
  });

  it('playwright junit with a CDATA failure', () => {
    const r = parseJUnit(fixture('playwright.xml'));
    assert.deepEqual(brief(r), ['x.spec.ts | area › ok | passed', 'x.spec.ts | area › bad | failed']);
    assert.match(r[1].message, /^x\.spec\.ts:2:79 › area › bad/);
    assert.doesNotMatch(r[1].message, /CDATA/);
  });

  it('pytest junit', () => {
    const r = parseJUnit(fixture('pytest.xml'));
    assert.deepEqual(brief(r), [
      'test_s.TestThing | test_ok | passed',
      'test_s.TestThing | test_bad | failed',
      'test_s.TestThing | test_skip | skipped',
      'test_s | test_top | passed',
    ]);
    assert.match(r[1].message, /self = <test_s.TestThing object/);
  });
});

describe('aggregate', () => {
  const run = (status, name = 't', file = '/home/runner/work/r/r/test/a.spec.ts') => ({ file, name, status, message: `${name} ${status}` });

  it('calls a test flaky when it fails some attempts and passes others, broken when it fails all', () => {
    const s = aggregate([
      run('passed', 'steady'), run('passed', 'steady'),
      run('failed', 'flaky'), run('passed', 'flaky'),
      run('failed', 'broken'), run('failed', 'broken'),
      run('skipped', 'skipped'), run('skipped', 'skipped'),
    ]);
    assert.equal(s.total, 3);
    assert.deepEqual(s.flaky.map((t) => [t.key, t.fails, t.passes]), [['a.spec.ts › flaky', 1, 1]]);
    assert.deepEqual(s.broken.map((t) => [t.key, t.fails, t.passes]), [['a.spec.ts › broken', 2, 0]]);
    assert.equal(s.flaky[0].message, 'flaky failed');
  });

  it('strips the runner workspace so keys match across machines', () => {
    const s = aggregate([run('passed', 'x', '/home/runner/work/r/r/src/a.spec.ts'), run('failed', 'x', '/home/runner/work/r/r/test/b.spec.ts')]);
    assert.deepEqual(s.broken.map((t) => t.key), ['test/b.spec.ts › x']);
  });

  it('leaves relative names alone', () => {
    const s = aggregate([run('failed', 'x', 'x.spec.ts'), run('passed', 'x', 'x.spec.ts')]);
    assert.deepEqual(s.flaky.map((t) => t.key), ['x.spec.ts › x']);
  });
});

describe('mask', () => {
  it('hides long tokens that mix letters and digits, keeps long words', () => {
    assert.equal(mask('key=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8 done'), 'key=[masked] done');
    assert.equal(mask('it_returns_the_policy_when_the_bundle_is_missing'), 'it_returns_the_policy_when_the_bundle_is_missing');
  });
});

describe('plan', () => {
  const t = (key, fails = 1, passes = 1) => ({ key, fails, passes, message: 'boom' });
  const ctx = { ref: 'dev', sha: '0123456789abcdef', runUrl: 'https://github.com/o/r/actions/runs/1' };

  it('opens one issue per new flaky test and skips ones already open', () => {
    const p = plan({ flaky: [t('a'), t('b')], broken: [] }, [flakyTitle('a')], ctx);
    assert.deepEqual(p.create.map((i) => i.title), ['Flaky test: b']);
    assert.match(p.create[0].body, /Failed 1 of 2 nightly attempts/);
    assert.match(p.create[0].body, /`0123456789`/);
    assert.equal(p.broken, null);
    assert.equal(p.skipped, 0);
  });

  it('opens at most ten issues per run and counts the rest', () => {
    const flaky = Array.from({ length: 13 }, (_, i) => t(`k${String(i).padStart(2, '0')}`));
    const p = plan({ flaky, broken: [] }, [], ctx);
    assert.equal(p.create.length, 10);
    assert.equal(p.skipped, 3);
  });

  it('lists every always-failing test in one issue', () => {
    const p = plan({ flaky: [], broken: [t('x', 5, 0), t('y', 5, 0)] }, [], ctx);
    assert.equal(p.broken.title, BROKEN_TITLE);
    assert.match(p.broken.body, /- `x`\n- `y`/);
  });

  it('keeps titles under the GitHub limit', () => {
    assert.ok(flakyTitle('x'.repeat(400)).length <= 240);
  });
});

describe('main', () => {
  const scratch = () => mkdtempSync(join(tmpdir(), 'flake-'));
  const quiet = (fn) => async () => {
    const log = console.log;
    const env = { ...process.env };
    console.log = () => {};
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_STEP_SUMMARY;
    try {
      await fn();
    } finally {
      console.log = log;
      process.env = env;
    }
  };

  it('fails when the attempts wrote no results', quiet(async () => {
    assert.equal(await main([scratch(), '5']), 1);
  }));

  it('passes on flaky-only results and fails when a test failed every attempt', quiet(async () => {
    const flakyOnly = scratch();
    for (const [i, status] of [[1, 'passed'], [2, 'failed']]) {
      mkdirSync(join(flakyOnly, `attempt-${i}`));
      writeFileSync(join(flakyOnly, `attempt-${i}`, 'r.json'), JSON.stringify({ testResults: [{ name: 'a.spec.ts', assertionResults: [{ fullName: 't', status }] }] }));
    }
    assert.equal(await main([flakyOnly, '2']), 0);

    const withBroken = scratch();
    cpSync(join(here, 'fixtures'), withBroken, { recursive: true });
    assert.equal(await main([withBroken, '1']), 1);
  }));

  it('counts each matrix leg apart and ignores the shard after ~', () => {
    const dir = scratch();
    const put = (artifact, status) => {
      mkdirSync(join(dir, artifact));
      writeFileSync(join(dir, artifact, 'r.json'), JSON.stringify({ testResults: [{ name: 'a.spec.ts', assertionResults: [{ fullName: 't', status }] }] }));
    };
    put('flake-1-node18', 'failed');
    put('flake-2-node18', 'failed');
    put('flake-1-node20', 'passed');
    put('flake-2-node20', 'passed');
    put('flake-1-~s1', 'passed');
    put('flake-2-~s3', 'failed');
    const s = aggregate(readResults(dir).results);
    assert.deepEqual(s.broken.map((t) => t.key), ['node18 › a.spec.ts › t']);
    assert.deepEqual(s.flaky.map((t) => t.key), ['a.spec.ts › t']);
  });

  it('reads the leg from the artifact name', () => {
    assert.equal(legOf('flake-3-py3.10'), 'py3.10');
    assert.equal(legOf('flake-3-real-frameworks'), 'real-frameworks');
    assert.equal(legOf('flake-12-~s4'), '');
    assert.equal(legOf('flake-2-node20~s1'), 'node20');
    assert.equal(legOf('results'), '');
  });

  it('reads every result file below the directory', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'a', 'b'), { recursive: true });
    cpSync(join(here, 'fixtures', 'pytest.xml'), join(dir, 'a', 'b', 'out.xml'));
    cpSync(join(here, 'fixtures', 'vitest.json'), join(dir, 'a', 'out.json'));
    const { files, results } = readResults(dir);
    assert.equal(files, 2);
    assert.equal(results.length, 7);
  });

  it('renders counts and both tables', () => {
    const md = render(aggregate(parseJestJson(fixture('jest.json'))), { attempts: 1, files: 1, runUrl: 'https://x/runs/1' });
    assert.match(md, /1 attempt, 1 result file, 3 tests\. Flaky: 0\. Failing every attempt: 2\./);
    assert.match(md, /\| broken\.test\.js › \(suite failed to run\) \| 1 of 1 \|/);
    assert.match(md, /\[Run log\]\(https:\/\/x\/runs\/1\)/);
  });
});
