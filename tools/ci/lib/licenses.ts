// Verificação de licenças do estágio Higiene (US-079 — RN-FND-21 · RN-FND-10 da US-077): em
// dependências de runtime dos apps só licenças da allowlist; GPL, AGPL, SSPL, BUSL e licenças
// desconhecidas bloqueiam, salvo exceção aprovada em `.github/ci-policy.yml`.
import type { LicenseException } from './policy.js';

type Node =
  | { readonly kind: 'id'; readonly id: string }
  | { readonly kind: 'and' | 'or'; readonly left: Node; readonly right: Node }
  | { readonly kind: 'with'; readonly license: Node; readonly exception: string };

class ParseError extends Error {}

function tokenize(expression: string): string[] {
  return expression
    .replace(/\(/g, ' ( ')
    .replace(/\)/g, ' ) ')
    .trim()
    .split(/\s+/)
    .filter((token) => token !== '');
}

const LICENSE_ID = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;

/** Gramática SPDX: `OR` < `AND` < `WITH`, com parênteses. */
export function parseSpdx(expression: string): Node {
  const tokens = tokenize(expression);
  let index = 0;
  const peek = () => tokens[index];
  const next = () => {
    const token = tokens[index];
    index += 1;
    if (token === undefined) throw new ParseError('fim inesperado');
    return token;
  };

  const primary = (): Node => {
    const token = next();
    if (token === '(') {
      const inner = orExpr();
      if (next() !== ')') throw new ParseError('parêntese não fechado');
      return inner;
    }
    if (/^(AND|OR|WITH)$/i.test(token) || !LICENSE_ID.test(token)) {
      throw new ParseError(`identificador inválido: ${token}`);
    }
    if (peek()?.toUpperCase() === 'WITH') {
      next();
      return { kind: 'with', license: { kind: 'id', id: token }, exception: next() };
    }
    return { kind: 'id', id: token };
  };
  const andExpr = (): Node => {
    let left = primary();
    while (peek()?.toUpperCase() === 'AND') {
      next();
      left = { kind: 'and', left, right: primary() };
    }
    return left;
  };
  const orExpr = (): Node => {
    let left = andExpr();
    while (peek()?.toUpperCase() === 'OR') {
      next();
      left = { kind: 'or', left, right: andExpr() };
    }
    return left;
  };

  const tree = orExpr();
  if (index !== tokens.length) throw new ParseError(`token inesperado: ${String(peek())}`);
  return tree;
}

function evaluate(node: Node, allowed: ReadonlySet<string>): boolean {
  switch (node.kind) {
    case 'id':
      return allowed.has(node.id.toLowerCase());
    case 'with':
      return evaluate(node.license, allowed);
    case 'and':
      return evaluate(node.left, allowed) && evaluate(node.right, allowed);
    case 'or':
      return evaluate(node.left, allowed) || evaluate(node.right, allowed);
  }
}

/**
 * A expressão é aceita? `A OR B` basta uma; `A AND B` exige as duas; `X WITH exceção` vale como
 * `X`. Expressão inválida, `UNLICENSED`, `Unknown` ou `SEE LICENSE IN …` = desconhecida → recusa.
 */
export function isLicenseAllowed(expression: string, allowed: readonly string[]): boolean {
  try {
    return evaluate(parseSpdx(expression), new Set(allowed.map((id) => id.toLowerCase())));
  } catch {
    return false;
  }
}

export interface PackageLicense {
  readonly name: string;
  readonly version: string;
  readonly license: string;
}

interface PnpmLicenseEntry {
  readonly name?: string;
  readonly versions?: readonly string[];
  readonly license?: string;
}

/** Interpreta `pnpm licenses list --json` (objeto licença → pacotes). */
export function parsePnpmLicenses(json: string): PackageLicense[] {
  const raw = JSON.parse(json.slice(json.indexOf('{'))) as Record<
    string,
    readonly PnpmLicenseEntry[]
  >;
  const result: PackageLicense[] = [];
  for (const [license, entries] of Object.entries(raw)) {
    for (const entry of entries) {
      const name = entry.name ?? '(sem nome)';
      for (const version of entry.versions ?? ['?']) {
        result.push({ name, version, license: entry.license ?? license });
      }
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function matchesPackage(pattern: string, name: string): boolean {
  return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : pattern === name;
}

export interface LicenseViolation extends PackageLicense {
  readonly message: string;
}

export interface LicenseReport {
  readonly checked: number;
  readonly violations: readonly LicenseViolation[];
  readonly excepted: readonly PackageLicense[];
  /** Exceções que não casaram com nenhum pacote (podem ser removidas da política). */
  readonly unusedExceptions: readonly LicenseException[];
}

/** Pacotes internos do workspace não entram na verificação (privados, nunca publicados). */
const INTERNAL_SCOPE = '@contrataflow/';

export function checkLicenses(
  packages: readonly PackageLicense[],
  allowed: readonly string[],
  exceptions: readonly LicenseException[],
): LicenseReport {
  const used = new Set<LicenseException>();
  const violations: LicenseViolation[] = [];
  const excepted: PackageLicense[] = [];
  let checked = 0;
  for (const pkg of packages) {
    if (pkg.name.startsWith(INTERNAL_SCOPE)) continue;
    checked += 1;
    if (isLicenseAllowed(pkg.license, allowed)) continue;
    const exception = exceptions.find(
      (item) => matchesPackage(item.package, pkg.name) && item.license === pkg.license,
    );
    if (exception) {
      used.add(exception);
      excepted.push(pkg);
      continue;
    }
    violations.push({
      ...pkg,
      message: `Licença "${pkg.license}" não permitida em ${pkg.name}@${pkg.version} (RN-FND-10). Troque a dependência ou registre a exceção aprovada em .github/ci-policy.yml.`,
    });
  }
  return {
    checked,
    violations,
    excepted,
    unusedExceptions: exceptions.filter((item) => !used.has(item)),
  };
}
