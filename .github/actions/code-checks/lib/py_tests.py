"""Skip sites and assertion counts for Python test files.

stdin: JSON [{"key": str, "text": str}]; stdout: JSON {key: {"asserts": int, "sites": [...]}}.
"""
import ast
import io
import json
import re
import sys
import tokenize

QUARANTINE = re.compile(r'quarantine:\s*#\d+|github\.com/[\w.-]+/[\w.-]+/issues/\d+')


def dotted(node):
    if isinstance(node, ast.Call):
        return dotted(node.func)
    if isinstance(node, ast.Attribute):
        inner = dotted(node.value)
        return f'{inner}.{node.attr}' if inner else node.attr
    if isinstance(node, ast.Name):
        return node.id
    return ''


def comments_by_line(text):
    out = {}
    try:
        for t in tokenize.generate_tokens(io.StringIO(text).readline):
            if t.type == tokenize.COMMENT:
                out[t.start[0]] = t.string
    except (tokenize.TokenError, IndentationError, SyntaxError):
        pass
    return out


def quarantined(line, comments):
    if QUARANTINE.search(comments.get(line, '')):
        return True
    above = line - 1
    while above in comments:
        if QUARANTINE.search(comments[above]):
            return True
        above -= 1
    return False


def analyze(text):
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return {'asserts': 0, 'sites': []}
    lines = text.split('\n')
    comments = comments_by_line(text)
    asserts = 0
    sites = []

    def site(node, first_line):
        sites.append({'kind': 'skip', 'line': node.lineno,
                      'key': 'skip:' + lines[node.lineno - 1].strip(),
                      'quarantined': quarantined(first_line, comments)})

    def visit(node, in_if):
        nonlocal asserts
        if isinstance(node, ast.Assert):
            asserts += 1
        if isinstance(node, ast.Call):
            name = dotted(node.func)
            last = name.rsplit('.', 1)[-1]
            if last.startswith('assert') or name in ('pytest.raises', 'raises'):
                asserts += 1
            if name in ('pytest.skip', 'skipTest') or name.endswith('.skipTest'):
                if not in_if:
                    site(node, node.lineno)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            for dec in node.decorator_list:
                name = dotted(dec)
                if name.endswith('mark.skip') or name in ('unittest.skip', 'skip'):
                    site(dec, dec.lineno)
        for child in ast.iter_child_nodes(node):
            visit(child, in_if or isinstance(node, ast.If))

    visit(tree, False)
    return {'asserts': asserts, 'sites': sites}


def main():
    req = json.load(sys.stdin)
    json.dump({item['key']: analyze(item['text']) for item in req}, sys.stdout)


main()
