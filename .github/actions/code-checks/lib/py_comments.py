"""Comment groups, docstrings and suppressions for Python files.

stdin: JSON {"root": str, "files": [str]}
stdout: JSON list, one entry per file that tokenizes.
"""
import ast
import io
import json
import re
import sys
import tokenize

DIRECTIVE = re.compile(r'#\s*(noqa|type:\s*ignore|pyright:\s*ignore)(?![\w-])(.*)$')
TOOL_COMMENT = re.compile(r'^(noqa|type:|pyright:|pylint:|nosec|fmt:|isort:|mypy:|pragma)')
CODE_HINT = re.compile(r'[=(\[:]|^(import|from|return|raise|del|assert|def|class|if|for|while|with|try)\b')
PROSE = re.compile(r'\b[a-z]{2,}\s+[a-z]{2,}\s+[a-z]{2,}\s+[a-z]{2,}\b', re.I)


def looks_like_code(lines):
    if not lines or len(lines) > 60:
        return False
    for line in lines:
        bare = re.sub(r'(["\']).*?\1', '', line)
        if not CODE_HINT.search(line) or PROSE.search(bare):
            return False
    try:
        tree = ast.parse('\n'.join(lines))
    except SyntaxError:
        return False
    body = tree.body
    if len(body) == 1 and isinstance(body[0], ast.Expr) and isinstance(body[0].value, (ast.Name, ast.Constant)):
        return False
    return bool(body)


def docstrings(tree):
    """Yield (stmt, owner) for every bare string statement; owner names the def it documents."""
    def walk(node, prefix):
        body = getattr(node, 'body', None)
        if not isinstance(body, list):
            return
        for i, stmt in enumerate(body):
            if isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Constant) and isinstance(stmt.value.value, str):
                yield stmt, (prefix if i == 0 else None)
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                yield from walk(stmt, f'{prefix}.{stmt.name}' if prefix else stmt.name)
            elif isinstance(stmt, (ast.If, ast.With, ast.Try, ast.For, ast.While)):
                yield from walk(stmt, prefix)
    yield from walk(tree, '')


def scan(root, rel):
    with open(f'{root}/{rel}', encoding='utf-8', errors='replace') as fh:
        src = fh.read()
    lines = src.split('\n')
    try:
        toks = list(tokenize.generate_tokens(io.StringIO(src).readline))
        tree = ast.parse(src)
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return None
    groups, suppressions, own_lines, doc_lines = [], [], set(), set()
    prev = None
    for t in (t for t in toks if t.type == tokenize.COMMENT):
        ln, col = t.start
        if ln == 1 and t.string.startswith('#!'):
            continue
        own = lines[ln - 1][:col].strip() == ''
        body = t.string[1:].strip()
        directive = bool(TOOL_COMMENT.match(body))
        m = DIRECTIVE.search(t.string)
        if m:
            rest = re.sub(r'^\s*(\[[^\]]*\]|:\s*[A-Z]+[0-9]*(\s*,\s*[A-Z]+[0-9]*)*)', '', m.group(2))
            reason = [w for w in re.split(r'\s+', rest.strip(' -:#')) if w]
            above = prev is not None and prev['own'] and not prev['directive'] and prev['endLine'] == ln - 1
            if len(reason) < 2 and not above:
                suppressions.append({'line': ln, 'directive': m.group(1)})
        if own:
            own_lines.add(ln)
        joins = (own and prev is not None and prev['own'] and not directive and not prev['directive']
                 and prev['endLine'] == ln - 1 and prev['col'] == col)
        if joins:
            prev['lines'].append(body)
            prev['rawLines'].append(t.string[1:].removeprefix(' '))
            prev['endLine'] = ln
            continue
        prev = {'type': 'Line', 'startLine': ln, 'endLine': ln, 'col': col, 'own': own,
                'directive': directive, 'lines': [body], 'rawLines': [t.string[1:].removeprefix(' ')]}
        groups.append(prev)
    for g in groups:
        g['lines'] = [l for l in g['lines'] if l]
        g['code'] = g['own'] and not g['directive'] and looks_like_code([l.rstrip() for l in g['rawLines'] if l.strip()])
        g['text'] = '\n'.join(g['lines'])
        del g['rawLines']
    for stmt, owner in docstrings(tree):
        doc_lines.update(range(stmt.lineno, stmt.end_lineno + 1))
        text = [l.strip() for l in stmt.value.value.split('\n') if l.strip()]
        groups.append({'type': 'Block', 'docstring': True, 'startLine': stmt.lineno, 'endLine': stmt.end_lineno,
                       'directive': False, 'code': False, 'lines': text, 'text': '\n'.join(text)})
    return {'path': rel, 'commentLines': len(own_lines | doc_lines), 'groups': groups, 'suppressions': suppressions}


def main():
    req = json.load(sys.stdin)
    out = []
    for rel in req['files']:
        r = scan(req['root'], rel)
        if r:
            out.append(r)
    json.dump(out, sys.stdout)


main()
