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

const SMOKE = new Set(['toBeDefined', 'toBeTruthy']);
const SMOKE_NEGATED = new Set(['toBeUndefined', 'toBeNull']);
const OBSERVABLE = /observable:\s*([^\n]*)/u;
const ASSERT_NAME = /^(expect|assert)([A-Z_]|$)/u;

const TEST_MODIFIERS = new Set(['each', 'concurrent', 'sequential']);
const isTestCall = (root, props) => (root === 'it' || root === 'test') && props.every((p) => TEST_MODIFIERS.has(p));

const fnArg = (node) => [...node.arguments].reverse().find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));

const hasSkipOption = (node) =>
  node.arguments.some(
    (a) =>
      ts.isObjectLiteralExpression(a) &&
      a.properties.some((p) => p.name && ts.isIdentifier(p.name) && ['skip', 'todo'].includes(p.name.text)),
  );

// Names of functions in the file whose body runs an assertion.
function assertingHelpers(sf) {
  const names = new Set();
  const runsAssert = (body) => {
    let found = false;
    const walk = (n) => {
      if (found) return;
      if (ts.isCallExpression(n)) {
        const { root } = chain(n.expression);
        if (root === 'expect' || root === 'assert') found = true;
      }
      ts.forEachChild(n, walk);
    };
    walk(body);
    return found;
  };
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body && runsAssert(node.body)) names.add(node.name.text);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
      runsAssert(node.initializer.body)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

// The argument of the `expect(...)` call at the root of a matcher chain.
function firstExpectArg(node) {
  let n = node.expression;
  while (n && !(ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'expect')) {
    n = ts.isCallExpression(n) || ts.isPropertyAccessExpression(n) ? n.expression : null;
  }
  return n ? n.arguments[0] : null;
}

const CONTAINER = /^(app|module|moduleRef|moduleFixture|testingModule|ref)$/u;
// `new X()`, or a DI lookup such as `moduleRef.get(X)`.
const constructs = (node) =>
  !!node &&
  (ts.isNewExpression(node) ||
    (ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['get', 'resolve'].includes(node.expression.name.text) &&
      ts.isIdentifier(node.expression.expression) &&
      CONTAINER.test(node.expression.expression.text)));

const literalPath = (node) =>
  !!node &&
  (ts.isStringLiteralLike(node) ||
    (ts.isIdentifier(node) && (node.text === '__dirname' || /^[A-Z][A-Z0-9_]*$/u.test(node.text))) ||
    (ts.isCallExpression(node) && node.arguments.every(literalPath)));

// Names the file binds to a constructed instance: `new X()`, `moduleRef.get(X)` and the like.
function instanceNames(sf) {
  const names = new Set();
  const visit = (node) => {
    let value = null;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) value = [node.name.text, node.initializer];
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      value = [node.left.text, node.right];
    }
    if (value) {
      let init = value[1];
      while (init && (ts.isAwaitExpression(init) || ts.isAsExpression(init) || ts.isParenthesizedExpression(init))) init = init.expression;
      if (constructs(init)) names.add(value[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

// Every assertion inside one test body, each as smoke or not.
function assertionsIn(body, helpers, instances) {
  const found = [];
  const walk = (n) => {
    if (ts.isCallExpression(n)) {
      const isCallee = ts.isCallExpression(n.parent) && n.parent.expression === n;
      const { root, props } = chain(n.expression);
      if (root === 'expect' && props.length && !isCallee && props[0] !== 'assertions' && props[0] !== 'hasAssertions') {
        const matcher = props[props.length - 1];
        const negated = props.includes('not');
        const subject = firstExpectArg(n);
        const constructed = !!subject && ((ts.isIdentifier(subject) && instances.has(subject.text)) || constructs(subject));
        found.push(constructed && (negated ? SMOKE_NEGATED.has(matcher) : SMOKE.has(matcher)));
      } else if (root === 'assert' && !isCallee) found.push(false);
      else if (propName(n.expression) === 'expect' && root !== 'expect') found.push(false);
      else if (
        ts.isIdentifier(n.expression) &&
        n.expression.text !== 'expect' &&
        (helpers.has(n.expression.text) || ASSERT_NAME.test(n.expression.text))
      ) {
        found.push(false);
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(body);
  return found;
}

// Skip and focus sites plus the number of assertion calls in one test file.
export function analyzeTs(path, text) {
  const sf = parse(path, text);
  const lines = text.split('\n');
  const sites = [];
  let asserts = 0;

  const helpers = assertingHelpers(sf);
  const instances = instanceNames(sf);

  const leadingOf = (stmt) =>
    (ts.getLeadingCommentRanges(text, stmt.pos) ?? []).map((r) => text.slice(r.pos, r.end)).join('\n');

  const marked = (stmt) => {
    const m = OBSERVABLE.exec(leadingOf(stmt));
    return !!m && (m[1].match(/[A-Za-z]{2,}/g) ?? []).length >= 5;
  };

  // An `// observable: <why>` comment of five words or more above the site's own
  // statement or above the test that holds it. A comment above a describe covers nothing.
  const observable = (node) => {
    if (marked(enclosingStatement(node))) return true;
    for (let n = node.parent; n && !ts.isSourceFile(n); n = n.parent) {
      if (!ts.isExpressionStatement(n) || !ts.isCallExpression(n.expression)) continue;
      const { root, props } = chain(n.expression.expression);
      if (isTestCall(root, props)) return marked(n);
      if (TEST_ROOTS.has(root)) return false;
    }
    return false;
  };

  const site = (node, kind) => {
    const stmt = enclosingStatement(node);
    const leading = leadingOf(stmt);
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    sites.push({
      kind,
      line: line + 1,
      key: `${kind}:${lines[line].trim()}`,
      quarantined: QUARANTINE.test(leading) || QUARANTINE.test(lines[line]),
      observable: kind.startsWith('smell:') && observable(node),
    });
  };

  const smells = (node) => {
    if (ts.isCallExpression(node) && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) {
      const { root, props } = chain(node.expression);
      const fn = isTestCall(root, props) && !hasSkipOption(node) ? fnArg(node) : null;
      if (fn) {
        const found = assertionsIn(fn.body, helpers, instances);
        if (!found.length) site(node, 'smell:no-assert');
        else if (found.every(Boolean)) site(node, 'smell:smoke-only');
      }
      const matcher = propName(node.expression);
      if (matcher === 'toHaveClass') site(node, 'smell:markup');
      if (
        (matcher === 'querySelector' || matcher === 'querySelectorAll') &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        /^\s*\./u.test(node.arguments[0].text)
      ) {
        site(node, 'smell:markup');
      }
      if (root === 'expect' && (matcher === 'toBe' || matcher === 'toBeFalsy')) {
        const target = chain(node.expression).root === 'expect' ? firstExpectArg(node) : null;
        const falsy = matcher === 'toBeFalsy' || node.arguments[0]?.kind === ts.SyntaxKind.FalseKeyword;
        if (
          falsy &&
          target &&
          ts.isCallExpression(target) &&
          /existsSync$/u.test(target.expression.getText(sf)) &&
          literalPath(target.arguments[0])
        ) {
          site(node, 'smell:file-absence');
        }
      }
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'invocationCallOrder') site(node, 'smell:call-order');
    if (ts.isPropertyAccessExpression(node) && /ForTests?$/u.test(node.name.text)) site(node, 'smell:test-hook');
  };

  const visit = (node) => {
    smells(node);
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
