export const MIN_REFETCH_MS = 60_000;

const SYNC_IO = /\b(readFileSync|writeFileSync|appendFileSync|readdirSync|statSync|existsSync|execSync|execFileSync|spawnSync)\s*\(/;
const REFETCH = /refetchInterval\s*:\s*([\d_]+)/;
const PY_SLEEP = /\btime\.sleep\s*\(/;
const SOURCE_ROOT = /(^|\/)(src|app|lib|armoriq_sdk|server)\//;

export function isRuntimeSource(path) {
  return SOURCE_ROOT.test(path);
}

export function lineSignals({ path, added }) {
  if (!isRuntimeSource(path)) return [];
  const signals = [];
  for (const [line, text] of added) {
    if (SYNC_IO.test(text)) signals.push([2, `${path}:${line} blocking ${text.match(SYNC_IO)[1]} in runtime code`]);
    const refetch = text.match(REFETCH);
    if (refetch && Number(refetch[1].replaceAll("_", "")) < MIN_REFETCH_MS) {
      signals.push([1, `${path}:${line} refetchInterval ${refetch[1]} ms is under ${MIN_REFETCH_MS} ms`]);
    }
    if (path.endsWith(".py") && PY_SLEEP.test(text)) signals.push([2, `${path}:${line} time.sleep in runtime code`]);
  }
  return signals;
}

export function loopAwaitSignals({ path, awaits, added }) {
  if (!isRuntimeSource(path)) return [];
  return awaits
    .filter((item) => added.has(item.line))
    .map((item) => [2, `${path}:${item.line} awaits ${item.call} inside a loop, one round trip per item`]);
}

export function scorePerformance(signals) {
  const lost = signals.reduce((sum, [points]) => sum + points, 0);
  return { score: Math.max(0, 10 - lost), deductions: signals.map(([points, reason]) => `-${points} ${reason}`) };
}
