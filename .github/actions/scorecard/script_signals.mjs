import tseslint from "typescript-eslint";
import { children, parserOptionsFor } from "./script_complexity.mjs";

const LOOPS = new Set(["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"]);
const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const ROUND_TRIP = /prisma|\$queryRaw|\$executeRaw|\$transaction|\.(findMany|findFirst|findUnique|create|createMany|update|updateMany|upsert|delete|deleteMany|count|aggregate)\(|\bfetch\(|axios|\.query\(|\brequest\(/;

function loopDepthFor(node, depth) {
  if (FUNCTIONS.has(node.type)) return 0;
  if (LOOPS.has(node.type) && !node.await) return depth + 1;
  return depth;
}

export function awaitsInLoops(code, filename) {
  if (!code) return [];
  const { ast } = tseslint.parser.parseForESLint(code, parserOptionsFor(filename));
  const found = [];
  const stack = [[ast, 0]];
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (node.type === "AwaitExpression" && depth > 0) {
      const call = code.slice(...node.argument.range).replaceAll(/\s+/g, " ");
      if (ROUND_TRIP.test(call)) found.push({ line: node.loc.start.line, call: call.slice(0, 60) });
    }
    const childDepth = loopDepthFor(node, depth);
    for (const child of children(node)) stack.push([child, childDepth]);
  }
  return found.sort((a, b) => a.line - b.line);
}
