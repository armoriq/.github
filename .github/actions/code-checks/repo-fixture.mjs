import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// A throwaway git repo: `files` on main, then `commit` adds changes on a branch.
export function repo(cli, files) {
  const dir = mkdtempSync(join(tmpdir(), 'code-checks-'));
  const run = (...args) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
      cwd: dir,
      stdio: 'pipe',
    });
  const write = (entries) => {
    for (const [path, text] of Object.entries(entries)) {
      if (text === null) {
        rmSync(join(dir, path));
        continue;
      }
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  };
  run('init', '-q', '-b', 'main');
  write(files);
  run('add', '-A');
  run('commit', '-q', '-m', 'base');
  run('checkout', '-q', '-b', 'change');
  return {
    dir,
    commit(entries) {
      write(entries);
      run('add', '-A');
      run('commit', '-q', '-m', 'change');
    },
    check(...args) {
      const r = spawnSync('node', [cli, ...args], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH } });
      return { code: r.status, out: r.stdout + r.stderr };
    },
  };
}
