import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import ts from 'typescript';
import { parse } from './js-comments.mjs';

const EXTS = ['.ts', '.tsx', '.mts', '.js', '.mjs', '/index.ts', '/index.tsx', '/index.js'];

function resolveModule(root, from, spec) {
  if (!spec.startsWith('.')) return null;
  const base = normalize(join(dirname(from), spec)).replace(/\.(js|mjs|cjs)$/, '');
  for (const ext of ['', ...EXTS]) {
    const cand = base + ext;
    if (existsSync(join(root, cand)) && /\.[cm]?[jt]sx?$/.test(cand)) return cand;
  }
  return null;
}

const hasExport = (node) =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

const declaredNames = (stmt) => {
  if (ts.isVariableStatement(stmt)) {
    return stmt.declarationList.declarations.filter((d) => ts.isIdentifier(d.name)).map((d) => d.name.text);
  }
  return stmt.name && ts.isIdentifier(stmt.name) ? [stmt.name.text] : [];
};

// Resolves the symbols an entry file exports to the files that declare them.
export function publicSymbols(root, entries) {
  const files = new Map();
  const sources = new Map();
  const source = (path) => {
    if (!sources.has(path)) sources.set(path, parse(path, readFileSync(join(root, path), 'utf8')));
    return sources.get(path);
  };
  const mark = (path, name) => {
    if (!files.has(path)) files.set(path, new Set());
    files.get(path).add(name);
  };
  const seen = new Set();

  const resolveName = (path, name) => {
    const key = `${path}#${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    const sf = source(path);
    for (const stmt of sf.statements) {
      if (declaredNames(stmt).includes(name)) return mark(path, name);
    }
    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt) && stmt.importClause?.namedBindings && ts.isNamedImports(stmt.importClause.namedBindings)) {
        for (const el of stmt.importClause.namedBindings.elements) {
          if (el.name.text !== name) continue;
          const target = resolveModule(root, path, stmt.moduleSpecifier.text);
          if (target) return resolveName(target, (el.propertyName ?? el.name).text);
        }
      }
      if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier) {
        const target = resolveModule(root, path, stmt.moduleSpecifier.text);
        if (!target) continue;
        if (!stmt.exportClause) resolveName(target, name);
        else if (ts.isNamedExports(stmt.exportClause)) {
          for (const el of stmt.exportClause.elements) {
            if (el.name.text === name) resolveName(target, (el.propertyName ?? el.name).text);
          }
        }
      }
    }
  };

  const exportAll = (path) => {
    const key = `${path}#*`;
    if (seen.has(key)) return;
    seen.add(key);
    for (const stmt of source(path).statements) {
      if (hasExport(stmt)) for (const name of declaredNames(stmt)) mark(path, name);
      if (!ts.isExportDeclaration(stmt)) continue;
      const target = stmt.moduleSpecifier && resolveModule(root, path, stmt.moduleSpecifier.text);
      if (!stmt.exportClause) {
        if (target) exportAll(target);
      } else if (ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          const local = (el.propertyName ?? el.name).text;
          if (target) resolveName(target, local);
          else resolveName(path, local);
        }
      }
    }
  };

  for (const entry of entries) if (existsSync(join(root, entry))) exportAll(entry);
  return files;
}

const isPrivateMember = (m) =>
  (m.name && ts.isPrivateIdentifier(m.name)) ||
  (m.name && ts.isIdentifier(m.name) && m.name.text.startsWith('_')) ||
  (ts.getModifiers?.(m) ?? []).some(
    (mod) => mod.kind === ts.SyntaxKind.PrivateKeyword || mod.kind === ts.SyntaxKind.ProtectedKeyword,
  );

const isJsDoc = (text, r) =>
  r.kind === ts.SyntaxKind.MultiLineCommentTrivia && text.startsWith('/**', r.pos) && r.end - r.pos > 4;

// Start offsets of the JSDoc comments on exported declarations and their public members.
export function exemptDocPositions(sf, names) {
  const out = new Set();
  const take = (node) => {
    for (const r of ts.getLeadingCommentRanges(sf.text, node.pos) ?? []) if (isJsDoc(sf.text, r)) out.add(r.pos);
  };
  for (const stmt of sf.statements) {
    if (!declaredNames(stmt).some((n) => names.has(n))) continue;
    take(stmt);
    const members = stmt.members ?? [];
    for (const m of members) if (!isPrivateMember(m)) take(m);
  }
  return out;
}
