export const COMMENT_TARGET = 0.0002;
export const COMPLEXITY_LIMIT = 10;
export const COMPLEXITY_GROWTH_LIMIT = 3;

const SLASH = /\.(c|m)?[jt]sx?$|\.prisma$/;
const HASH = /\.(py|sh|ya?ml)$/;
const SQL = /\.sql$/;
const IGNORED = /(^|\/)(node_modules|vendor|dist|build|coverage|__generated__|generated)\/|\.min\.|\.d\.ts$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|uv\.lock)$/;
const TEST = /(^|\/)(test|tests|__tests__|e2e|fixtures)\/|\.(spec|test)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$|(^|\/)conftest\.py$/;

export function commentSyntax(path) {
  if (IGNORED.test(path)) return null;
  if (SLASH.test(path)) return "slash";
  if (HASH.test(path)) return "hash";
  if (SQL.test(path)) return "sql";
  return null;
}

export function isTestPath(path) {
  return TEST.test(path);
}

export function isCommentLine(syntax, text) {
  const line = text.trim();
  if (syntax === "slash") return /^(\/\/|\/\*|\*|\{\s*\/\*)/.test(line);
  if (syntax === "hash") return line.startsWith("#") && !line.startsWith("#!");
  if (syntax === "sql") return line.startsWith("--");
  return false;
}

export function countComments({ path, added, docstringLines = new Set() }) {
  const syntax = commentSyntax(path);
  const result = { added: 0, comments: 0, lines: [] };
  if (!syntax) return result;
  for (const [line, text] of added) {
    if (!text.trim()) continue;
    result.added += 1;
    if (docstringLines.has(line) || isCommentLine(syntax, text)) {
      result.comments += 1;
      result.lines.push(line);
    }
  }
  return result;
}

export function keyFunctions(functions) {
  const seen = new Map();
  return functions.map((fn) => {
    const index = seen.get(fn.name) ?? 0;
    seen.set(fn.name, index + 1);
    return { ...fn, key: `${fn.name}#${index}` };
  });
}

export function complexityFlags({ path, before, after, addedLines }) {
  const previous = new Map(keyFunctions(before).map((fn) => [fn.key, fn.complexity]));
  const flags = [];
  for (const fn of keyFunctions(after)) {
    if (!addedLines.some((line) => line >= fn.start && line <= fn.end)) continue;
    const was = previous.get(fn.key);
    const grew = was !== undefined && fn.complexity - was >= COMPLEXITY_GROWTH_LIMIT;
    const kind = was === undefined ? "new" : grew ? "grown" : "touched";
    if (fn.complexity > COMPLEXITY_LIMIT || grew) {
      flags.push({ path, line: fn.start, name: fn.name, complexity: fn.complexity, was, kind });
    }
  }
  return flags;
}

export function densityDeduction(ratio) {
  if (ratio <= COMMENT_TARGET) return 0;
  if (ratio <= 0.01) return 1;
  if (ratio <= 0.05) return 2;
  if (ratio <= 0.15) return 3;
  return 4;
}

const percent = (ratio) => `${(ratio * 100).toFixed(2)}%`;

export function scoreCleanCode({ added, comments }) {
  const ratio = added ? comments / added : 0;
  const points = densityDeduction(ratio);
  const deductions = points
    ? [`-${points} source comments ${percent(ratio)} of ${added} added lines, target ${percent(COMMENT_TARGET)}: delete ${comments} line(s)`]
    : [];
  return { score: 10 - points, deductions };
}

const COMPLEXITY_POINTS = { new: 2, grown: 2, touched: 1 };

function describeFlag(flag) {
  const where = `${flag.name} (${flag.path}:${flag.line})`;
  if (flag.kind === "grown") return `${where} grew from ${flag.was} to ${flag.complexity}`;
  if (flag.kind === "new") return `${where} is new at ${flag.complexity}`;
  return `${where} is ${flag.complexity} and the change didn't grow it`;
}

export function scoreComplexity(flags) {
  const lost = flags.reduce((sum, flag) => sum + COMPLEXITY_POINTS[flag.kind], 0);
  const deductions = flags.map((flag) => `-${COMPLEXITY_POINTS[flag.kind]} ${describeFlag(flag)}`);
  return { score: Math.max(0, 10 - lost), deductions };
}
