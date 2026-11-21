#!/usr/bin/env node
import { fileURLToPath } from 'node:url';

export const LINES_PER_SHARD = 100;

const size = (range) => {
  const m = /:(\d+)-(\d+)$/.exec(range);
  return m ? Number(m[2]) - Number(m[1]) + 1 : 1;
};

export function shard(mutate, maxShards, linesPerShard = LINES_PER_SHARD) {
  const ranges = mutate.split(',').filter(Boolean);
  if (!ranges.length) return [];
  const total = ranges.reduce((sum, r) => sum + size(r), 0);
  const count = Math.max(1, Math.min(maxShards, ranges.length, Math.ceil(total / linesPerShard)));
  const bins = Array.from({ length: count }, () => ({ lines: 0, ranges: [] }));
  const bySize = ranges.map((r, i) => ({ r, i, n: size(r) })).sort((a, b) => b.n - a.n || a.i - b.i);
  for (const item of bySize) {
    const bin = bins.reduce((min, b) => (b.lines < min.lines ? b : min));
    bin.lines += item.n;
    bin.ranges.push(item);
  }
  return bins.map((b, index) => ({
    index,
    lines: b.lines,
    mutate: b.ranges.sort((x, y) => x.i - y.i).map((x) => x.r).join(','),
  }));
}

function main(argv) {
  const max = Number(argv[0] ?? '1');
  if (!Number.isInteger(max) || max < 1) {
    console.error('Usage: MUTATE=<patterns> shard.mjs <max-shards>');
    return 2;
  }
  process.stdout.write(JSON.stringify(shard(process.env.MUTATE ?? '', max)));
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
