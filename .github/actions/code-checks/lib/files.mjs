import { extname } from 'node:path';

export const JS_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
export const PY_EXT = new Set(['.py']);

const EXCLUDED_DIR =
  /(^|\/)(node_modules|dist|build|out|coverage|\.next|vendor|third_party|generated|__generated__|migrations|fixtures|__fixtures__|testdata|docs)(\/|$)/;
const EXCLUDED_FILE = /(\.d\.[cm]?ts$|\.min\.js$|\.generated\.|_pb2(_grpc)?\.py$)/;

const TEST_NAME =
  /(\.(spec|test|e2e)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$|(^|\/)conftest\.py$)/;

export const isCode = (path) => JS_EXT.has(extname(path)) || PY_EXT.has(extname(path));
export const isPython = (path) => PY_EXT.has(extname(path));
export const isTestFile = (path) => isCode(path) && TEST_NAME.test(path);

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function inScope(path, extraExcludes = []) {
  if (!isCode(path) || EXCLUDED_DIR.test(path) || EXCLUDED_FILE.test(path)) return false;
  return !extraExcludes.some((re) => re.test(path));
}

export function parseConfig(text) {
  const raw = text ? JSON.parse(text) : {};
  return {
    exclude: (raw.exclude ?? []).map(globToRegExp),
    publicApi: raw.publicApi ?? [],
  };
}
