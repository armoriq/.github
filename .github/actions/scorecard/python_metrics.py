import ast
import json
import sys

import lizard


def docstring_lines(code):
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return []
    lines = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                lines.update(range(first.lineno, first.end_lineno + 1))
    return sorted(lines)


def functions(path, code):
    info = lizard.analyze_file.analyze_source_code(path, code)
    return [
        {"name": fn.name, "complexity": fn.cyclomatic_complexity, "start": fn.start_line, "end": fn.end_line}
        for fn in info.function_list
    ]


code = sys.stdin.read()
json.dump({"functions": functions(sys.argv[1], code), "docstrings": docstring_lines(code)}, sys.stdout)
