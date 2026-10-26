/** Evaluates SPDX licence expressions against an allow-list (AC-23). */

export const ALLOWED_LICENSES: ReadonlySet<string> = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Apache-2.0',
  'Unlicense',
  'CC0-1.0',
  'BlueOak-1.0.0',
]);

type Token = '(' | ')' | 'AND' | 'OR' | { readonly id: string };

function tokenize(expression: string): Token[] | undefined {
  const tokens: Token[] = [];
  for (const raw of expression
    .replace(/([()])/g, ' $1 ')
    .trim()
    .split(/\s+/)) {
    if (raw === '') continue;
    if (raw === '(' || raw === ')' || raw === 'AND' || raw === 'OR') {
      tokens.push(raw);
    } else if (/^[A-Za-z0-9.+-]+$/.test(raw) && raw !== 'WITH') {
      tokens.push({ id: raw });
    } else {
      return undefined;
    }
  }
  return tokens;
}

/**
 * `true` only when the expression is well formed and satisfiable from the allow-list: an `OR` needs
 * one allowed side, an `AND` needs both. Anything unparseable (including `WITH` exceptions, an
 * empty or unknown licence) fails.
 */
export function isAllowedExpression(expression: string): boolean {
  const tokens = tokenize(expression);
  if (tokens === undefined || tokens.length === 0) return false;
  let position = 0;

  const parseOr = (): boolean | undefined => {
    let value = parseAnd();
    while (value !== undefined && tokens[position] === 'OR') {
      position += 1;
      const right = parseAnd();
      if (right === undefined) return undefined;
      value = value || right;
    }
    return value;
  };
  const parseAnd = (): boolean | undefined => {
    let value = parseAtom();
    while (value !== undefined && tokens[position] === 'AND') {
      position += 1;
      const right = parseAtom();
      if (right === undefined) return undefined;
      value = value && right;
    }
    return value;
  };
  const parseAtom = (): boolean | undefined => {
    const token = tokens[position];
    position += 1;
    if (token === '(') {
      const value = parseOr();
      if (tokens[position] !== ')') return undefined;
      position += 1;
      return value;
    }
    if (typeof token === 'object') return ALLOWED_LICENSES.has(token.id);
    return undefined;
  };

  const result = parseOr();
  return result === true && position === tokens.length;
}
