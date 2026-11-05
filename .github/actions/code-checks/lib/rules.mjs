export const MAX_LINES = 4;

const DIVIDER = /^[\s\-=*#~_/\\─━═+|<>]{4,}$|[-=─━═]{5,}/u;
const PLAN_LABEL = /(?<![\w#.-])(D\d{2,3}|C\d[a-z]?|P\d|H\d|T\d{1,2}|O\d)(?![\w-])/u;
const HISTORY =
  /\b(?:phase\s*[0-9]+[a-z]?|per (?:the )?(?:prd|plan)|we (?:decided|chose|picked|agreed)|used to be|temporar(?:y|ily)|for now|design decision|(?:our|the) decision (?:was|is) to|(?:we|i) made the decision|the plan (?:says|is|was) to|judge?ment call|first cut)\b|\bdeviat|\bprd\s*§|(?:^|[.;]\s+)previously\b|\bpreviously(?=,)/imu;
const BARE_REF = /(?<![\w/&#.-])#[1-9]\d{1,4}(?![\w-])/u;
const URL_REF = /github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/\d+/u;
const TASK = /\b(TODO|FIXME|HACK)\b|\bXXX:/u;
const TASK_LINK = /#\d+|github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+/u;
const TEST_MARKER = /(^|\n)\s*(regression|quarantine):\s*#\d+/u;
const LICENSE = /^!|@license|\bcopyright\b|SPDX-License-Identifier/iu;

export const MESSAGES = {
  banner: 'Drop the divider; let the structure of the code show the grouping.',
  'history-ref': 'Drop the issue or PR number; git history records it. Keep the reason.',
  'plan-label':
    'Drop the plan or decision label (D85, C1, T8); say the reason in plain words or put it in the PR body.',
  'history-phrase':
    'Drop the history or rationale ("previously", "for now", "phase N", "per PRD", "design decision", "first cut"); say what the code does now.',
  'commented-out-code': 'Delete the commented-out code; git keeps it.',
  'block-over-4-lines': `Cut this comment to ${MAX_LINES} lines or fewer: keep the constraint, drop the background.`,
  'suppression-without-reason':
    'Say why: end with `-- reason` (eslint, oxlint), `: reason` (biome), or write the reason after the code (@ts-expect-error, noqa, type: ignore).',
  'todo-without-link': 'Link the issue that tracks this, or drop the marker.',
};

// Code spans and quoted UI copy are content, not narration.
const scrub = (text) => text.replace(/`[^`]*`/gu, '``').replace(/"[^"\n]*"/gu, '""');

// Rules for one comment group. `g.code` says whether its lines parse as code.
export function groupRules(g) {
  if (g.directive || g.lines.length === 0) return [];
  const found = [];
  const text = scrub(g.text);
  if (g.lines.some((l) => DIVIDER.test(l))) found.push('banner');
  const task = TASK.test(text);
  if (task && !TASK_LINK.test(g.text)) found.push('todo-without-link');
  if (!task && !TEST_MARKER.test(g.text) && (BARE_REF.test(text) || URL_REF.test(text))) {
    found.push('history-ref');
  }
  if (PLAN_LABEL.test(text)) found.push('plan-label');
  if (HISTORY.test(text)) found.push('history-phrase');
  if (g.code) found.push('commented-out-code');
  if (g.lines.length > MAX_LINES && !g.exempt && !LICENSE.test(g.text)) found.push('block-over-4-lines');
  return found;
}

const JS_SUPPRESSION =
  /^\s*\*?\s*(eslint-disable(?:-next-line|-line)?|oxlint-disable(?:-next-line|-line)?|@ts-ignore|@ts-expect-error|@ts-nocheck|biome-ignore(?:-all|-start)?)(?![\w-])(.*)$/su;

const words = (s) => s.split(/\s+/).filter(Boolean).length;

// Returns the directive name when it gives no reason, otherwise null.
export function jsSuppressionWithoutReason(value) {
  const m = JS_SUPPRESSION.exec(value);
  if (!m) return null;
  const [, directive, rest] = m;
  let ok;
  if (/^(eslint|oxlint)/.test(directive)) ok = /(^|\s)--\s*\S/.test(rest);
  else if (directive.startsWith('biome')) ok = /:\s*\S/.test(rest) && !/<explanation>/.test(rest);
  else ok = words(rest.replace(/^[\s:-]+/, '')) >= 2;
  return ok ? null : directive;
}
