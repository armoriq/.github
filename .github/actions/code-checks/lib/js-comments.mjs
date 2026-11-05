import ts from 'typescript';

export const scriptKind = (path) =>
  /\.[cm]?[jt]sx$/.test(path)
    ? ts.ScriptKind.TSX
    : /\.[cm]?ts$/.test(path)
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS;

export const parse = (path, text) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));

const DIRECTIVE =
  /^\s*\*?\s*(eslint-|oxlint-|@ts-|biome-ignore|prettier-ignore|c8 |istanbul |#(end)?region|global |@jsx|@vitest-environment|@jest-environment)/u;

// Every comment in the file, found as trivia around real tokens, so string,
// template and regex contents are never mistaken for comments. JSX `{/* */}`
// is trivia of the closing brace token.
export function comments(sf) {
  const text = sf.text;
  const seen = new Map();
  const add = (ranges) => {
    for (const r of ranges ?? []) if (!seen.has(r.pos)) seen.set(r.pos, r);
  };
  const visit = (node) => {
    if (node.kind >= ts.SyntaxKind.FirstToken && node.kind <= ts.SyntaxKind.LastToken) {
      if (node.kind !== ts.SyntaxKind.JsxText) {
        add(ts.getLeadingCommentRanges(text, node.pos));
        add(ts.getTrailingCommentRanges(text, node.end));
      }
      return;
    }
    if (node.kind === ts.SyntaxKind.JsxText) return;
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);
  add(ts.getLeadingCommentRanges(text, 0));
  const lines = text.split('\n');
  return [...seen.values()]
    .sort((a, b) => a.pos - b.pos)
    .map((r) => {
      const raw = text.slice(r.pos, r.end);
      const start = sf.getLineAndCharacterOfPosition(r.pos);
      const end = sf.getLineAndCharacterOfPosition(r.end);
      const isLine = r.kind === ts.SyntaxKind.SingleLineCommentTrivia;
      const value = isLine ? raw.slice(2) : raw.replace(/^\/\*\*?/, '').replace(/\*\/$/, '');
      return {
        pos: r.pos,
        end: r.end,
        type: isLine ? 'Line' : 'Block',
        jsdoc: raw.startsWith('/**') && !raw.startsWith('/**/'),
        value,
        lines: value.split('\n').map((l) => l.replace(/^\s*\*?\s?/, '').trim()),
        startLine: start.line + 1,
        endLine: end.line + 1,
        col: start.character,
        ownLine: (lines[start.line] ?? '').slice(0, start.character).trim() === '',
        directive: DIRECTIVE.test(value),
      };
    });
}

// Consecutive own-line `//` comments at one column read as one comment.
// Directives always stand alone so they never inflate a block's length.
export function groups(list) {
  const out = [];
  for (const c of list) {
    const prev = out.at(-1)?.comments.at(-1);
    const joins =
      c.type === 'Line' &&
      prev?.type === 'Line' &&
      c.ownLine &&
      prev.ownLine &&
      !c.directive &&
      !prev.directive &&
      prev.endLine === c.startLine - 1 &&
      prev.col === c.col;
    if (joins) out.at(-1).comments.push(c);
    else out.push({ comments: [c] });
  }
  return out.map((g) => ({
    comments: g.comments,
    type: g.comments[0].type,
    jsdoc: g.comments[0].jsdoc,
    pos: g.comments[0].pos,
    ownLine: g.comments[0].ownLine,
    directive: g.comments.some((c) => c.directive),
    lines: g.comments.flatMap((c) => c.lines).filter((l) => l !== ''),
    rawLines: g.comments.map((c) => c.value.replace(/^\s?/, '')),
    text: g.comments.map((c) => c.value).join('\n'),
    startLine: g.comments[0].startLine,
    endLine: g.comments.at(-1).endLine,
  }));
}

// Lines whose only non-blank characters are comment text (JSX braces allowed).
export function commentOnlyLines(text, list) {
  const mask = new Uint8Array(text.length);
  for (const c of list) mask.fill(1, c.pos, c.end);
  let count = 0;
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    let inComment = false;
    let other = false;
    for (let i = start; i < end && !other; i++) {
      const ch = text[i];
      if (mask[i]) {
        if (!/\s/.test(ch)) inComment = true;
      } else if (!/\s/.test(ch) && ch !== '{' && ch !== '}') other = true;
    }
    if (inComment && !other) count++;
    start = end + 1;
  }
  return count;
}

const PROSE = /\b[a-z]{2,}\s+[a-z]{2,}\s+[a-z]{2,}\s+[a-z]{2,}\b/i;
const CODE_PUNCT = /[;{}()=[\]]|=>|:\s*['"\w]/;
const ONE_LINE_CODE =
  /^(?:(?:(?:const|let|var)\s+[\w${}[\], ]+=.*|import\s.+\sfrom\s+["'].+["']|(?:await\s+|return\s+)?[\w$.]+\(.*\)|[\w$.[\]]+\s*=\s*.+);|(?:if|for|while|switch)\s*\(.*\)\s*\{|\}(?:\s*else\s*\{)?)$/u;

function parsesAsCode(src) {
  const wraps = [(x) => x, (x) => `x = {\n${x}\n}`, (x) => `x = [\n${x}\n]`];
  if (/^\s*<[A-Za-z/]/.test(src)) wraps.push((x) => `<>\n${x}\n</>`);
  for (const wrap of wraps) {
    const sf = ts.createSourceFile('c.tsx', wrap(src), ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
    if (sf.parseDiagnostics.length > 0) continue;
    const [first] = sf.statements;
    const bare =
      sf.statements.length === 1 &&
      ts.isExpressionStatement(first) &&
      (ts.isIdentifier(first.expression) || ts.isLiteralExpression(first.expression));
    if (!bare) return true;
  }
  return false;
}

// True when two or more comment lines in a row parse as code, or a lone line
// has an unmistakable statement shape.
export function looksLikeCode(rawLines) {
  if (rawLines.length > 60) return false;
  if (rawLines.length === 1) return ONE_LINE_CODE.test(rawLines[0].trim());
  const codey = rawLines.map((l) => CODE_PUNCT.test(l) && !PROSE.test(l.replace(/(['"`]).*?\1/g, '')));
  for (let i = 0; i < rawLines.length; i++) {
    if (!codey[i]) continue;
    for (let j = rawLines.length; j > i + 1; j--) {
      const slice = rawLines.slice(i, j);
      if (slice.filter((_, k) => codey[i + k]).length < Math.ceil(slice.length * 0.6)) continue;
      if (parsesAsCode(slice.join('\n'))) return true;
    }
  }
  return false;
}
