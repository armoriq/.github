#!/usr/bin/env node
// Prints the PR's added line ranges as Stryker mutate patterns:
//   ranges.mjs --base <rev> -- <pathspec>...   ->   src/a.ts:3-9,src/b.ts:12-12
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function parseRanges(diff) {
  const out = [];
  let file = null;
  let prev = '';
  for (const line of diff.split('\n')) {
    const header = line.startsWith('+++ ') && prev.startsWith('--- ');
    prev = line;
    if (header) {
      file = line === '+++ /dev/null' ? null : line.slice(6);
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m || !file) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count > 0) out.push(`${file}:${start}-${start + count - 1}`);
  }
  return out;
}

function main(argv) {
  const sep = argv.indexOf('--');
  const base = argv[argv.indexOf('--base') + 1];
  if (!argv.includes('--base') || sep === -1 || sep === argv.length - 1) {
    console.error('Usage: ranges.mjs --base <rev> -- <pathspec>...');
    return 2;
  }
  const diff = execFileSync(
    'git',
    ['diff', '-U0', '--no-renames', '--no-color', '--diff-filter=AM', base, 'HEAD', '--', ...argv.slice(sep + 1)],
    { encoding: 'utf8', maxBuffer: 1 << 28 },
  );
  process.stdout.write(parseRanges(diff).join(','));
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
