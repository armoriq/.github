export const LOCKING_RULES = new Set([
  "require-concurrent-index-creation",
  "constraint-missing-not-valid",
  "adding-foreign-key-constraint",
  "changing-column-type",
  "adding-required-field",
  "disallowed-unique-constraint",
  "ban-drop-column",
  "ban-drop-table",
]);

export const FEEDER_CHECKS = {
  "Deploy dry run": [4, "the deploy dry run failed"],
  "DB specs ran": [2, "DB integration specs were skipped"],
};

const UI_FILE = /\.(tsx|jsx|css|scss|vue|svelte)$/;
const IMAGE = /!\[[^\]]*\]\(|<img\b|user-attachments\/assets/;
const ISSUE_LINK = /#\d+|github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+/;
const HEDGE = /\b(temporary|temporarily|workaround|for now|hack)\b/i;
const ENV_READ = /process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[["']([A-Z][A-Z0-9_]*)["']\]|os\.(?:getenv|environ\.get)\(\s*["']([A-Z][A-Z0-9_]*)["']|os\.environ\[["']([A-Z][A-Z0-9_]*)["']\]|\.get(?:OrThrow)?(?:<[^>]*>)?\(\s*["']([A-Z][A-Z0-9_]*)["']/g;
const CREATED_TABLE = /create\s+table\s+(?:if\s+not\s+exists\s+)?"?([\w.]+)"?/gi;
const TARGET_TABLE = /\b(?:on|alter\s+table(?:\s+only)?(?:\s+if\s+exists)?)\s+"?([\w.]+)"?/i;
const INDEX_NAME = /create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?"?([\w.]+)"?/i;

function statementAt(lines, index) {
  const start = lines.slice(0, index).findLastIndex((line) => line.includes(";")) + 1;
  const end = lines.findIndex((line, at) => at >= index && line.includes(";"));
  return lines.slice(start, end === -1 ? undefined : end + 1).join(" ");
}

function createdTables(lines) {
  return new Set([...lines.join("\n").matchAll(CREATED_TABLE)].map((match) => match[1]));
}

function blocksWrites(finding, lines, concurrentIndexes) {
  const statement = statementAt(lines, finding.line);
  if (createdTables(lines).has(statement.match(TARGET_TABLE)?.[1])) return false;
  if (finding.rule_name !== "require-concurrent-index-creation") return true;
  const name = statement.match(INDEX_NAME)?.[1];
  return !name || !concurrentIndexes.has(name);
}

export function lockingFindings({ findings, sqlLines, concurrentIndexes }) {
  return findings
    .filter((finding) => LOCKING_RULES.has(finding.rule_name))
    .filter((finding) => blocksWrites(finding, sqlLines.get(finding.file) ?? [], concurrentIndexes))
    .map((finding) => `${finding.file}:${finding.line + 1} ${finding.rule_name}`);
}

export function concurrentIndexNames(text) {
  const names = new Set();
  for (const match of text.matchAll(/create\s+(?:unique\s+)?index\s+concurrently\s+(?:if\s+not\s+exists\s+)?"?([\w.]+)"?/gi)) {
    names.add(match[1]);
  }
  return names;
}

export function envReads(text) {
  return [...text.matchAll(ENV_READ)].map((match) => match.slice(1).find(Boolean));
}

export function documentedEnv(envExample) {
  return new Set([...envExample.matchAll(/^\s*#?\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/gm)].map((match) => match[1]));
}

export function undocumentedEnv({ addedSource, envExample }) {
  if (envExample === null) return [];
  const documented = documentedEnv(envExample);
  return [...new Set(addedSource.flatMap(envReads))].filter((name) => !documented.has(name)).sort();
}

export function hygieneFindings({ body, changedPaths }) {
  const text = body ?? "";
  const findings = [];
  if (!ISSUE_LINK.test(text)) findings.push([1, "the PR body links no issue"]);
  if (HEDGE.test(text) && !ISSUE_LINK.test(text)) findings.push([1, "the PR body calls the change temporary or a workaround with no linked issue"]);
  if (changedPaths.some((path) => UI_FILE.test(path)) && !IMAGE.test(text)) {
    findings.push([2, "a UI file changed and the PR body has no screenshot"]);
  }
  return findings;
}

export function feederFindings(checks) {
  return checks
    .filter((check) => FEEDER_CHECKS[check.name] && check.done && check.result !== "success" && check.result !== "skipped")
    .map((check) => FEEDER_CHECKS[check.name]);
}

export function scoreProductionization({ facts, checks }) {
  const hits = [
    ...facts.lockingMigrations.map((finding) => [2, `migration blocks writes: ${finding}`]),
    ...facts.undocumentedEnv.map((name) => [1, `${name} is read but missing from .env.example`]),
    ...facts.hygiene,
    ...feederFindings(checks),
  ];
  const lost = hits.reduce((sum, [points]) => sum + points, 0);
  return { score: Math.max(0, 10 - lost), deductions: hits.map(([points, reason]) => `-${points} ${reason}`) };
}
