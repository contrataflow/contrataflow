// Lint de SQL do estágio "2. Estático" (US-081 — RN-FND-44 · V-05): contexto de tenant só por
// transação. `set_config(…, false)` ou `SET [SESSION] app.*` fixa a variável na CONEXÃO, que volta
// ao pool e serve outro tenant (PgBouncer em modo transação/RDS Proxy) — vazamento entre clientes.
// Vale para migrações e para o SQL embutido no código das aplicações.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export interface SqlFinding {
  readonly file: string;
  readonly line: number;
  readonly rule: 'tenant/session-context';
  readonly message: string;
}

export const SESSION_CONTEXT_MESSAGE =
  'Migração bloqueada: contexto de sessão proibido. Use set_config(…, true) dentro da transação (TenantTransaction — RN-FND-44).';

/** Onde procurar: migrações, código e testes das apps e scripts de init do PostgreSQL. */
const ROOTS = [
  'apps/api/prisma/migrations',
  'apps/api/src',
  'apps/api/test',
  'apps/worker/src',
  'infra/postgres',
];
const EXTENSIONS = new Set(['.sql', '.ts', '.sh']);
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'generated', 'coverage', '.turbo']);

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** Troca comentários `--` de SQL por espaços (preserva índices e linhas). */
function blankSqlComments(text: string): string {
  return text.replace(/--[^\n]*/g, (comment) => ' '.repeat(comment.length));
}

/**
 * Argumentos de nível superior de uma chamada, a partir do índice logo após `(`. Respeita aspas
 * simples/duplas, parênteses aninhados e interpolações `${…}` de template literal.
 */
export function callArguments(text: string, start: number): string[] | null {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  for (let index = start; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (char === "'" || char === '"') {
      const end = text.indexOf(char, index + 1);
      if (end === -1) return null;
      current += text.slice(index, end + 1);
      index = end;
      continue;
    }
    if (char === '$' && text.charAt(index + 1) === '{') {
      const end = text.indexOf('}', index);
      if (end === -1) return null;
      current += text.slice(index, end + 1);
      index = end;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') {
      if (depth === 0) {
        args.push(current.trim());
        return args;
      }
      depth -= 1;
    }
    if (char === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  return null;
}

/**
 * `set_config` cujo terceiro argumento não é o literal `true` e `SET [SESSION] app.*` (o `SET LOCAL`
 * é permitido: vale só para a transação).
 */
export function lintSessionContext(file: string, source: string): SqlFinding[] {
  const text = file.endsWith('.sql') ? blankSqlComments(source) : source;
  const findings: SqlFinding[] = [];
  const report = (index: number) =>
    findings.push({
      file,
      line: lineOf(text, index),
      rule: 'tenant/session-context',
      message: SESSION_CONTEXT_MESSAGE,
    });

  for (const match of text.matchAll(/\bset_config\s*\(/gi)) {
    const args = callArguments(text, match.index + match[0].length);
    // Menos de 3 argumentos não é uma chamada válida (ex.: citação "set_config(…, false)" em texto).
    if (args === null || args.length < 3) continue;
    if (args[2]?.toLowerCase() !== 'true') report(match.index);
  }
  for (const match of text.matchAll(/\bSET\s+(?:SESSION\s+)?"?app\.\w+"?\s*(?:=|\bTO\b)/gi)) {
    report(match.index);
  }
  return findings;
}

function walk(dir: string, files: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIPPED_DIRS.has(entry)) walk(full, files);
    } else if (EXTENSIONS.has(path.extname(entry))) {
      files.push(full);
    }
  }
}

/** Arquivos verificados, relativos à raiz e com `/`. */
export function sqlLintTargets(root: string): string[] {
  const files: string[] = [];
  for (const dir of ROOTS) walk(path.join(root, dir), files);
  return files.map((file) => path.relative(root, file).split(path.sep).join('/')).sort();
}

export function lintRepository(root: string): SqlFinding[] {
  return sqlLintTargets(root).flatMap((file) =>
    lintSessionContext(file, readFileSync(path.join(root, file), 'utf8')),
  );
}
