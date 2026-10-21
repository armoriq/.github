import { Linter } from "eslint";
import tseslint from "typescript-eslint";

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const OWNER_TYPES = new Set(["MethodDefinition", "Property", "PropertyDefinition"]);
const SKIPPED_KEYS = new Set(["parent", "loc", "range", "tokens", "comments"]);
const SCRIPT_FILES = "**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}";
const linter = new Linter({ configType: "flat" });

export function children(node) {
  return Object.entries(node)
    .filter(([key]) => !SKIPPED_KEYS.has(key))
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
    .filter((value) => value && typeof value.type === "string");
}

const keyName = (owner) => owner.key?.name ?? owner.key?.value;
const PARENT_NAMES = {
  MethodDefinition: keyName,
  Property: keyName,
  PropertyDefinition: keyName,
  VariableDeclarator: (declarator) => declarator.id?.name,
};

function nameOf(node, parent) {
  return node.id?.name ?? PARENT_NAMES[parent?.type]?.(parent);
}

function functionRanges(ast) {
  const ranges = [];
  const stack = [[ast, null]];
  while (stack.length) {
    const [node, parent] = stack.pop();
    if (FUNCTION_TYPES.has(node.type)) {
      const owner = OWNER_TYPES.has(parent?.type) ? parent : node;
      ranges.push({ start: owner.loc.start.line, end: node.loc.end.line, name: nameOf(node, parent) });
    }
    for (const child of children(node)) stack.push([child, node]);
  }
  return ranges;
}

function smallestRangeAt(ranges, line) {
  const containing = ranges.filter((range) => range.start <= line && line <= range.end);
  if (!containing.length) return { start: line, end: line, name: undefined };
  return containing.reduce((best, range) => (range.end - range.start < best.end - best.start ? range : best));
}

export const parserOptionsFor = (filename) => ({ ecmaFeatures: { jsx: /x$/.test(filename) }, loc: true, range: true });

export function measureScript(code, filename) {
  if (!code) return [];
  const parserOptions = parserOptionsFor(filename);
  const config = [
    {
      files: [SCRIPT_FILES],
      linterOptions: { noInlineConfig: true },
      languageOptions: { parser: tseslint.parser, parserOptions },
      rules: { complexity: ["error", 0] },
    },
  ];
  const messages = linter.verify(code, config, { filename });
  const failure = messages.find((message) => message.fatal || message.message.startsWith("No matching configuration"));
  if (failure) throw new Error(`${filename}:${failure.line}: ${failure.message}`);
  const ranges = functionRanges(tseslint.parser.parseForESLint(code, parserOptions).ast);
  return messages
    .filter((message) => message.ruleId === "complexity")
    .map((message) => {
      const [, reported, complexity] = message.message.match(/(?:'([^']+)' )?has a complexity of (\d+)/);
      const { start, end, name } = smallestRangeAt(ranges, message.line);
      return { name: reported ?? name ?? "anonymous", complexity: Number(complexity), start, end };
    });
}
