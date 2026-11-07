import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_EXCERPT_LINES = 20;
const MAX_LISTED = 50;

const decode = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');

const attrs = (s) => Object.fromEntries([...s.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, k, v]) => [k, decode(v)]));

export function parseJestJson(text) {
  const report = JSON.parse(text);
  const out = [];
  for (const file of report.testResults ?? []) {
    const assertions = file.assertionResults ?? [];
    if (!assertions.length && file.status === 'failed') {
      out.push({ file: file.name, name: '(suite failed to run)', status: 'failed', message: file.message ?? '' });
      continue;
    }
    for (const a of assertions) {
      const status = a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'skipped';
      const name = (a.fullName || [...(a.ancestorTitles ?? []), a.title].join(' ')).trim();
      out.push({ file: file.name, name, status, message: (a.failureMessages ?? []).join('\n') });
    }
  }
  return out;
}

const cdata = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

// Reads one start tag at `at`. Quote-aware: node:test leaves `>` unescaped inside attribute values.
function readTag(text, at, name) {
  let i = at + name.length + 1;
  let quote = '';
  for (; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') break;
  }
  const raw = text.slice(at + name.length + 1, i);
  return { attrs: attrs(raw), selfClosing: raw.trimEnd().endsWith('/'), end: i + 1 };
}

function* elements(text, name) {
  const open = new RegExp(`<${name}(?=[\\s/>])`, 'g');
  let m;
  while ((m = open.exec(text))) {
    const tag = readTag(text, m.index, name);
    if (tag.selfClosing) {
      open.lastIndex = tag.end;
      yield { attrs: tag.attrs, body: '' };
      continue;
    }
    const close = text.indexOf(`</${name}>`, tag.end);
    const stop = close === -1 ? text.length : close;
    open.lastIndex = stop;
    yield { attrs: tag.attrs, body: text.slice(tag.end, stop) };
  }
}

export function parseJUnit(text) {
  const out = [];
  for (const { attrs: a, body } of elements(text, 'testcase')) {
    const failure = elements(body, 'failure').next().value ?? elements(body, 'error').next().value;
    const status = failure ? 'failed' : /<skipped(?=[\s/>])/.test(body) ? 'skipped' : 'passed';
    const detail = failure?.body ? decode(cdata(failure.body)).trim() : '';
    const message = failure ? detail || failure.attrs.message || '' : '';
    const group = a.classname && a.classname !== a.file && a.classname !== 'test' ? a.classname : '';
    const file = a.file || group;
    const name = a.file && group ? `${group} › ${a.name ?? ''}` : (a.name ?? '');
    out.push({ file, name, status, message });
  }
  return out;
}

export const legOf = (artifact) => (artifact.match(/^flake-\d+-?(.*)$/)?.[1] ?? '').split('~')[0];

export function readResults(dir) {
  const files = [];
  const walk = (d, leg) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) walk(p, leg ?? legOf(entry));
      else if (/\.(json|xml)$/.test(entry)) files.push({ path: p, leg: leg ?? '' });
    }
  };
  walk(dir);
  const results = [];
  for (const { path, leg } of files) {
    const text = readFileSync(path, 'utf8');
    const parsed = path.endsWith('.xml') ? parseJUnit(text) : parseJestJson(text);
    results.push(...parsed.map((r) => ({ ...r, leg })));
  }
  return { files: files.length, results };
}

function commonDir(paths) {
  const abs = paths.filter((p) => p.startsWith('/')).map((p) => p.split('/').slice(0, -1));
  if (!abs.length) return '';
  let prefix = abs[0];
  for (const parts of abs.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < parts.length && prefix[i] === parts[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix.length > 1 ? `${prefix.join('/')}/` : '';
}

export function aggregate(results) {
  const strip = commonDir(results.map((r) => r.file));
  const tests = new Map();
  for (const r of results) {
    if (r.status === 'skipped') continue;
    const file = strip && r.file.startsWith(strip) ? r.file.slice(strip.length) : r.file;
    const key = [r.leg, file, r.name].filter(Boolean).join(' › ');
    const t = tests.get(key) ?? { key, passes: 0, fails: 0, message: '' };
    if (r.status === 'passed') t.passes++;
    else {
      t.fails++;
      if (!t.message) t.message = r.message;
    }
    tests.set(key, t);
  }
  const all = [...tests.values()].sort((a, b) => a.key.localeCompare(b.key));
  return {
    total: all.length,
    flaky: all.filter((t) => t.fails > 0 && t.passes > 0),
    broken: all.filter((t) => t.fails > 0 && t.passes === 0),
  };
}

export const mask = (text) =>
  text.replace(/[A-Za-z0-9_-]{32,}=*/g, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? '[masked]' : m));

export function excerpt(message) {
  const lines = mask(message.replace(/\u001b\[[0-9;]*m/g, '')).split('\n');
  const shown = lines.slice(0, MAX_EXCERPT_LINES);
  if (lines.length > shown.length) shown.push(`... ${lines.length - shown.length} more lines`);
  return shown.join('\n').replace(/```/g, "'''");
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const rate = (t) => `${t.fails} of ${t.fails + t.passes}`;
const cell = (s) => s.replace(/\|/g, '\\|');

export function render(summary, { attempts, runUrl = '', files = 0 }) {
  const lines = [
    '### Flake hunt',
    '',
    `${plural(attempts, 'attempt')}, ${plural(files, 'result file')}, ${plural(summary.total, 'test')}. Flaky: ${summary.flaky.length}. Failing every attempt: ${summary.broken.length}.`,
  ];
  for (const [title, list] of [
    ['Flaky (failed some attempts, passed others)', summary.flaky],
    ['Failing every attempt', summary.broken],
  ]) {
    if (!list.length) continue;
    lines.push('', `#### ${title}`, '', '| Test | Failed |', '| --- | --- |');
    for (const t of list.slice(0, MAX_LISTED)) lines.push(`| ${cell(t.key)} | ${rate(t)} |`);
    if (list.length > MAX_LISTED) lines.push('', `${list.length - MAX_LISTED} more not listed.`);
  }
  if (runUrl) lines.push('', `[Run log](${runUrl})`);
  return lines.join('\n');
}
