import { excerpt } from './report.mjs';

export const LABEL = 'flaky-test';
export const BROKEN_TITLE = 'Tests fail on every nightly attempt';
const MAX_NEW = 10;
const MAX_TITLE = 240;

export const flakyTitle = (key) => {
  const t = `Flaky test: ${key}`;
  return t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE - 3)}...` : t;
};

const context = ({ ref, sha, runUrl }) =>
  [`Branch \`${ref}\` at ${sha ? `\`${sha.slice(0, 10)}\`` : 'an unknown commit'}.`, runUrl ? `[Run log](${runUrl})` : '']
    .filter(Boolean)
    .join(' ');

export function flakyBody(t, ctx) {
  return [
    `\`${t.key}\``,
    '',
    `Failed ${t.fails} of ${t.fails + t.passes} nightly attempts and passed the rest. ${context(ctx)}`,
    '',
    'First failure:',
    '',
    '```',
    excerpt(t.message || '(no failure message)'),
    '```',
    '',
    'Close this issue once the cause is fixed. The flake hunt opens a new one if the test turns flaky again.',
  ].join('\n');
}

export function brokenBody(list, ctx) {
  return [
    `These tests failed on every nightly attempt. ${context(ctx)}`,
    '',
    ...list.slice(0, 50).map((t) => `- \`${t.key}\``),
    ...(list.length > 50 ? [`- ${list.length - 50} more`] : []),
    '',
    'The flake hunt rewrites this list each night while the issue is open.',
  ].join('\n');
}

export function plan(summary, openTitles, ctx) {
  const open = new Set(openTitles);
  const create = [];
  for (const t of summary.flaky) {
    const title = flakyTitle(t.key);
    if (!open.has(title) && create.length < MAX_NEW) create.push({ title, body: flakyBody(t, ctx) });
  }
  const broken = summary.broken.length ? { title: BROKEN_TITLE, body: brokenBody(summary.broken, ctx) } : null;
  return { create, broken, skipped: summary.flaky.length - create.length - summary.flaky.filter((t) => open.has(flakyTitle(t.key))).length };
}
