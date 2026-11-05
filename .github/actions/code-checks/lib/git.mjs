import { execFileSync } from 'node:child_process';

export const git = (args, opts = {}) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });

export const tryGit = (args) => {
  try {
    return git(args, { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};

export const repoRoot = () => git(['rev-parse', '--show-toplevel']).trim();

export const mergeBase = (base) => git(['merge-base', base, 'HEAD']).trim();

export const showAt = (rev, path) => tryGit(['show', `${rev}:${path}`]);

export const trackedFiles = () => git(['ls-files', '-z']).split('\0').filter(Boolean);

// Map of path -> [[start, end], ...] for lines the diff adds on the HEAD side.
export function addedRanges(base) {
  const out = new Map();
  let file = null;
  for (const line of git(['diff', '-U0', '-M', '--no-color', base, 'HEAD']).split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line === '+++ /dev/null' ? null : line.slice(6);
      if (file) out.set(file, []);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && file) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (count > 0) out.get(file).push([start, start + count - 1]);
    }
  }
  return out;
}

// [{status, from, to}] with renames tracked; status is the first letter (A, M, D, R, C).
export function changedFiles(base) {
  return git(['diff', '--name-status', '-M', '--no-color', base, 'HEAD'])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, a, b] = line.split('\t');
      return { status: status[0], from: a, to: b ?? a };
    });
}
