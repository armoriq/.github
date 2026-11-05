import ts from 'typescript';
import { parse } from './js-comments.mjs';

const TEST_ROOTS = new Set(['it', 'test', 'describe', 'suite', 'context']);
const SKIP_FNS = new Set(['xit', 'xdescribe', 'xtest', 'xcontext']);
const FOCUS_FNS = new Set(['fit', 'fdescribe', 'ftest']);
const ASSERT_ROOTS = new Set(['expect', 'assert']);
export const QUARANTINE = /quarantine:\s*#\d+|github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+/u;

const propName = (node) => {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return null;
};

// `it.skip.each(rows)` -> { root: 'it', props: ['skip', 'each'] }
function chain(node) {
  if (ts.isIdentifier(node)) return { root: node.text, props: [] };
  if (ts.isCallExpression(node)) return chain(node.expression);
  const name = propName(node);
  if (name === null) return { root: null, props: [] };
  const inner = chain(node.expression);
  return { root: inner.root, props: [...inner.props, name] };
}

const isLiteralTitle = (node) =>
  !node || ts.isStringLiteralLike(node) || ts.isFunctionLike(node) || ts.isTemplateExpression(node);

const isLiteralFlag = (node) =>
  node && (node.kind === ts.SyntaxKind.TrueKeyword || ts.isStringLiteralLike(node));

const enclosingStatement = (node) => {
  let n = node;
  while (n.parent && !ts.isSourceFile(n.parent) && !ts.isBlock(n.parent)) n = n.parent;
  return n;
};

// Skip and focus sites plus the number of assertion calls in one test file.
export function analyzeTs(path, text) {
  const sf = parse(path, text);
  const lines = text.split('\n');
  const sites = [];
  let asserts = 0;

  const site = (node, kind) => {
    const stmt = enclosingStatement(node);
    const leading = (ts.getLeadingCommentRanges(text, stmt.pos) ?? []).map((r) => text.slice(r.pos, r.end)).join('\n');
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    sites.push({
      kind,
      line: line + 1,
      key: `${kind}:${lines[line].trim()}`,
      quarantined: QUARANTINE.test(leading) || QUARANTINE.test(lines[line]),
    });
  };

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isCallee = ts.isCallExpression(node.parent) && node.parent.expression === node;
      if (ts.isIdentifier(callee) && ASSERT_ROOTS.has(callee.text)) asserts++;
      else if (ts.isPropertyAccessExpression(callee)) {
        const obj = callee.expression;
        if ((ts.isIdentifier(obj) && ASSERT_ROOTS.has(obj.text)) || propName(obj) === 'assert') asserts++;
      }
      if (ts.isIdentifier(callee) && SKIP_FNS.has(callee.text)) site(node, 'skip');
      else if (ts.isIdentifier(callee) && FOCUS_FNS.has(callee.text)) site(node, 'focus');
      else if (!isCallee) {
        const { root, props } = chain(callee);
        if (TEST_ROOTS.has(root)) {
          const last = propName(callee);
          if (props.includes('only')) site(node, 'focus');
          else if (props.includes('skip') || props.includes('todo')) {
            const gate = last === 'skip' && !isLiteralTitle(node.arguments[0]);
            if (!gate) site(node, 'skip');
          } else {
            for (const arg of node.arguments) {
              if (!ts.isObjectLiteralExpression(arg)) continue;
              for (const p of arg.properties) {
                const name = p.name && ts.isIdentifier(p.name) ? p.name.text : null;
                if (!ts.isPropertyAssignment(p) || !isLiteralFlag(p.initializer)) continue;
                if (name === 'only') site(node, 'focus');
                else if (name === 'skip' || name === 'todo') site(node, 'skip');
              }
            }
          }
        }
      }
    } else if (ts.isPropertyAccessExpression(node) && ['skip', 'only', 'todo'].includes(node.name.text)) {
      const parent = node.parent;
      const used =
        (ts.isCallExpression(parent) && parent.expression === node) ||
        ts.isPropertyAccessExpression(parent) ||
        ts.isConditionalExpression(parent);
      if (!used && TEST_ROOTS.has(chain(node).root)) site(node, node.name.text === 'only' ? 'focus' : 'skip');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { asserts, sites };
}
