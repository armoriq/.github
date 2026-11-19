#!/usr/bin/env node
// Renders a Stryker JSON report as the sticky PR comment: comment.mjs <report.json> [run-url]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKER = '<!-- mutation-report -->';
const MAX_SURVIVORS = 20;

const code = (s) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  const short = flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
  return `<code>${short.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code>`;
};

export function merge(reports) {
  const present = reports.filter(Boolean);
  if (!present.length) return null;
  const files = {};
  for (const report of present) {
    for (const [path, file] of Object.entries(report.files ?? {})) {
      const into = (files[path] ??= { ...file, mutants: [] });
      into.mutants.push(...(file.mutants ?? []));
    }
  }
  return { ...present[0], files };
}

export function readReports(path) {
  if (!path || !existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [JSON.parse(readFileSync(path, 'utf8'))];
  return readdirSync(path, { recursive: true })
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(path, name), 'utf8')));
}

export function render(report, { runUrl = '', cwd = process.cwd(), missing = 0, expected = 0 } = {}) {
  const head = [MARKER, '### Mutation report', ''];
  const gap = missing ? ['', `${missing} of ${expected} shards produced no report, so their mutants are not counted above.`] : [];
  const footer = [...gap, ...(runUrl ? ['', `[Run log](${runUrl})`] : [])];
  if (!report) {
    return [...head, 'Stryker did not produce a report for this run.', ...footer].join('\n');
  }
  const counts = { Killed: 0, Survived: 0, Timeout: 0, NoCoverage: 0, CompileError: 0, RuntimeError: 0 };
  const survivors = [];
  for (const [path, file] of Object.entries(report.files ?? {})) {
    const rel = path.startsWith('/') ? relative(cwd, path) : path;
    for (const m of file.mutants ?? []) {
      if (m.status in counts) counts[m.status]++;
      if (m.status === 'Survived') {
        survivors.push({ rel, line: m.location.start.line, mutator: m.mutatorName, replacement: m.replacement ?? '' });
      }
    }
  }
  survivors.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line);
  const detected = counts.Killed + counts.Timeout;
  const valid = detected + counts.Survived + counts.NoCoverage;
  const score = valid ? `${((100 * detected) / valid).toFixed(1)}%` : 'n/a';
  const lines = [
    ...head,
    'Stryker mutated the lines this PR adds. This report never blocks the merge.',
    '',
    '| Score | Killed | Survived | Timeout | No coverage | Errors |',
    '| --- | --- | --- | --- | --- | --- |',
    `| ${score} | ${counts.Killed} | ${counts.Survived} | ${counts.Timeout} | ${counts.NoCoverage} | ${counts.CompileError + counts.RuntimeError} |`,
  ];
  if (survivors.length) {
    const shown = survivors.slice(0, MAX_SURVIVORS);
    lines.push('', `Surviving mutants${survivors.length > shown.length ? ` (first ${shown.length} of ${survivors.length})` : ''}:`, '');
    for (const s of shown) lines.push(`- \`${s.rel}:${s.line}\` ${s.mutator} ${code(s.replacement)}`);
  }
  return [...lines, ...footer].join('\n');
}

function main(argv) {
  const [reportPath, runUrl = '', expectedArg = '1'] = argv;
  const reports = readReports(reportPath);
  const expected = Math.max(Number(expectedArg) || 1, reports.length);
  const missing = expected - reports.length;
  process.stdout.write(`${render(merge(reports), { runUrl, missing: reports.length ? missing : 0, expected })}\n`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
