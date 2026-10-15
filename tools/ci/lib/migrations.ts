// Estágio "Migrações" (US-079 — RN-FND-25 · V-08): migrações do Prisma em
// `apps/api/prisma/migrations/<nome>/migration.sql` (layout da US-081). Lint expand/contract,
// imutabilidade das migrações já publicadas e as checagens de catálogo de multi-tenancy.md §14.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { filesAtRef, showFile } from './git.js';
import type { EphemeralPostgres } from './postgres.js';
import { lintSessionContext } from './sql-lint.js';

export const MIGRATIONS_DIR = 'apps/api/prisma/migrations';

export interface Migration {
  /** Nome do diretório (`20261101120000_cria_processos`): define a ordem. */
  readonly name: string;
  /** Caminho do `migration.sql` relativo à raiz. */
  readonly file: string;
  readonly sql: string;
  readonly checksum: string;
}

function migration(name: string, sql: string): Migration {
  const normalized = sql.replace(/\r\n/g, '\n');
  return {
    name,
    file: `${MIGRATIONS_DIR}/${name}/migration.sql`,
    sql: normalized,
    checksum: createHash('sha256').update(normalized).digest('hex'),
  };
}

/** Migrações da árvore de trabalho, em ordem. */
export function listMigrations(root: string): Migration[] {
  const dir = path.join(root, MIGRATIONS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => statSync(path.join(dir, entry)).isDirectory())
    .filter((entry) => existsSync(path.join(dir, entry, 'migration.sql')))
    .sort()
    .map((entry) => migration(entry, readFileSync(path.join(dir, entry, 'migration.sql'), 'utf8')));
}

/** Migrações de uma versão do Git (base do PR ou *snapshot* da versão publicada). */
export function listMigrationsAtRef(ref: string, cwd?: string): Migration[] {
  return filesAtRef(ref, MIGRATIONS_DIR, cwd)
    .filter((file) => file.endsWith('/migration.sql'))
    .map((file) => file.slice(MIGRATIONS_DIR.length + 1, -'/migration.sql'.length))
    .filter((name) => !name.includes('/'))
    .sort()
    .map((name) =>
      migration(name, showFile(ref, `${MIGRATIONS_DIR}/${name}/migration.sql`, cwd) ?? ''),
    );
}

export type FindingLevel = 'error' | 'warning';

export interface MigrationFinding {
  readonly level: FindingLevel;
  readonly file: string;
  readonly line?: number;
  readonly rule: string;
  readonly message: string;
}

/** Marcador que autoriza a fase *contract* (release posterior), citando a decisão ou story. */
const CONTRACT_MARKER = /--\s*cf:contract\s+(DEC|ADR|US)-\d{3}\b/i;

const DESTRUCTIVE: readonly { rule: string; pattern: RegExp; what: string }[] = [
  { rule: 'drop-table', pattern: /\bDROP\s+TABLE\b/i, what: 'DROP TABLE' },
  { rule: 'drop-column', pattern: /\bDROP\s+COLUMN\b/i, what: 'DROP COLUMN' },
  { rule: 'rename', pattern: /\bRENAME\s+(COLUMN\b|TO\b|CONSTRAINT\b)/i, what: 'RENAME' },
  {
    rule: 'alter-type',
    pattern: /\bALTER\s+COLUMN\s+"?\w+"?\s+(SET\s+DATA\s+)?TYPE\b/i,
    what: 'ALTER COLUMN … TYPE',
  },
  {
    rule: 'set-not-null',
    pattern: /\bALTER\s+COLUMN\s+"?\w+"?\s+SET\s+NOT\s+NULL\b/i,
    what: 'SET NOT NULL',
  },
  { rule: 'drop-schema', pattern: /\bDROP\s+SCHEMA\b/i, what: 'DROP SCHEMA' },
  { rule: 'truncate', pattern: /\bTRUNCATE\b/i, what: 'TRUNCATE' },
];

function stripComments(line: string): string {
  return line.replace(/--.*$/, '');
}

function lineOf(sql: string, index: number): number {
  return sql.slice(0, index).split('\n').length;
}

/** Nome sem aspas e sem schema `public` (`"public"."processes"` → `processes`). */
function tableName(raw: string): string {
  return raw
    .replace(/"/g, '')
    .replace(/^public\./i, '')
    .toLowerCase();
}

/**
 * Lint de uma migração NOVA (ainda não publicada):
 * - expand/contract: operação destrutiva só com `-- cf:contract DEC-NNN` (release posterior);
 * - tabela criada com `tenant_id` precisa de RLS ENABLE + FORCE e política na mesma migração;
 * - contexto de tenant nunca de sessão (`set_config(…, false)`/`SET app.*` — RN-FND-44).
 */
export function lintMigration(item: Migration): MigrationFinding[] {
  const findings: MigrationFinding[] = lintSessionContext(item.file, item.sql).map((finding) => ({
    level: 'error',
    ...finding,
  }));
  const contract = CONTRACT_MARKER.test(item.sql);
  const lines = item.sql.split('\n');

  if (!contract) {
    lines.forEach((raw, index) => {
      const code = stripComments(raw);
      for (const { rule, pattern, what } of DESTRUCTIVE) {
        if (!pattern.test(code)) continue;
        findings.push({
          level: 'error',
          file: item.file,
          line: index + 1,
          rule: `expand-contract/${rule}`,
          message: `${what} quebra a versão N-1 da aplicação (expand/contract — architecture.md §11.4). Faça em release posterior, numa migração marcada com "-- cf:contract DEC-NNN".`,
        });
      }
    });
  }

  const code = lines.map(stripComments).join('\n');
  const createTable =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:"?\w+"?\.)?"?\w+"?)\s*\(([\s\S]*?)\);/gi;
  for (const match of code.matchAll(createTable)) {
    const [, rawName = '', body = ''] = match;
    if (!/(^|[\s,(])"?tenant_id"?\s/i.test(body)) continue;
    const table = tableName(rawName);
    const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const target = `(?:"?public"?\\.)?"?${escaped}"?`;
    const enable = new RegExp(
      `ALTER\\s+TABLE\\s+${target}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`,
      'i',
    );
    const force = new RegExp(
      `ALTER\\s+TABLE\\s+${target}\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY`,
      'i',
    );
    const policy = new RegExp(`CREATE\\s+POLICY\\s+"?\\w+"?\\s+ON\\s+${target}\\b`, 'i');
    const missing = [
      enable.test(code) ? undefined : 'ENABLE ROW LEVEL SECURITY',
      force.test(code) ? undefined : 'FORCE ROW LEVEL SECURITY',
      policy.test(code) ? undefined : 'CREATE POLICY',
    ].filter((item): item is string => item !== undefined);
    if (missing.length > 0) {
      findings.push({
        level: 'error',
        file: item.file,
        line: lineOf(code, match.index),
        rule: 'tenant/rls',
        message: `Tabela ${table} tem tenant_id sem ${missing.join(', ')} (DEC-082 · multi-tenancy.md §14).`,
      });
    }
  }
  return findings;
}

/** Migrações já publicadas (na base) não podem mudar nem sumir: corrige-se para frente. */
export function checkPublished(
  published: readonly Migration[],
  current: readonly Migration[],
): MigrationFinding[] {
  const byName = new Map(current.map((item) => [item.name, item]));
  const findings: MigrationFinding[] = [];
  for (const item of published) {
    const now = byName.get(item.name);
    if (!now) {
      findings.push({
        level: 'error',
        file: item.file,
        rule: 'published/removed',
        message: `Migração já publicada foi removida: ${item.name}. Migrações não são revertidas — crie uma nova.`,
      });
    } else if (now.checksum !== item.checksum) {
      findings.push({
        level: 'error',
        file: item.file,
        line: 1,
        rule: 'published/modified',
        message: `Migração já publicada foi alterada: ${item.name}. Crie uma migração nova em vez de editar esta.`,
      });
    }
  }
  return findings;
}

/** Migrações do PR que ainda não existem na base. */
export function newMigrations(
  published: readonly Migration[],
  current: readonly Migration[],
): Migration[] {
  const names = new Set(published.map((item) => item.name));
  return current.filter((item) => !names.has(item.name));
}

/** Tabelas de plataforma, sem `tenant_id` (lista fechada de DEC-080). */
export const PLATFORM_TABLES = ['tenants', 'users', 'permissions', '_prisma_migrations'] as const;

/** Tabelas em que `tenant_id` nulo marca registro de plataforma (DEC-080 · multi-tenancy.md §6). */
export const NULLABLE_TENANT_TABLES = ['audit_logs', 'outbox_events'] as const;

/** Dono de todos os objetos do schema da aplicação (RN-FND-46). */
export const OWNER_ROLE = 'cf_owner';

const sqlList = (items: readonly string[]) =>
  items.map((item) => `'${item.replace(/'/g, "''")}'`).join(', ');

/**
 * Checagens de catálogo (multi-tenancy.md §14 · V-02/V-03), uma linha por violação (partição é
 * checada como tabela própria — RLS, FK, unicidade —, mas herda da raiz a exceção de `tenant_id`
 * nulo, ex.: `audit_logs_2026_10` — US-073):
 * `rls|<tabela>`, `fk|<tabela>|<constraint>`, `unique|<tabela>|<índice>`, `nullable|<tabela>`,
 * `platform|<tabela>` (sem `tenant_id` fora da lista de plataforma) e `owner|<tabela>|<dono>`
 * (só no schema `public`, que nasce das migrações).
 */
export function catalogChecksSql(schemas: readonly string[]): string {
  const list = sqlList(schemas);
  const ownerCheck = schemas.includes('public')
    ? `
UNION ALL
SELECT 'owner|public.' || c.relname || '|' || pg_get_userbyid(c.relowner)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND n.nspname = 'public' AND c.relname <> '_prisma_migrations'
  AND pg_get_userbyid(c.relowner) <> '${OWNER_ROLE}'`
    : '';
  return `WITH tenant_tables AS (
  SELECT c.oid, n.nspname || '.' || c.relname AS name, c.relname, c.relrowsecurity,
         c.relforcerowsecurity, a.attnum AS tenant_attnum, a.attnotnull AS tenant_not_null,
         (SELECT r.relname FROM pg_class r
           WHERE r.oid = coalesce(pg_partition_root(c.oid), c.oid)) AS root_relname
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
  WHERE c.relkind IN ('r', 'p') AND n.nspname IN (${list})
)
SELECT 'rls|' || t.name FROM tenant_tables t
WHERE NOT t.relrowsecurity OR NOT t.relforcerowsecurity
   OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = t.oid)
UNION ALL
SELECT 'fk|' || src.name || '|' || k.conname
FROM pg_constraint k
JOIN tenant_tables src ON src.oid = k.conrelid
JOIN tenant_tables dst ON dst.oid = k.confrelid
WHERE k.contype = 'f' AND NOT (src.tenant_attnum = ANY (k.conkey))
UNION ALL
SELECT 'unique|' || t.name || '|' || i.indexrelid::regclass::text
FROM pg_index i
JOIN tenant_tables t ON t.oid = i.indrelid
WHERE i.indisunique AND NOT i.indisprimary AND NOT (t.tenant_attnum = ANY (i.indkey::int2[]))
UNION ALL
SELECT 'nullable|' || t.name FROM tenant_tables t
WHERE NOT t.tenant_not_null AND t.root_relname NOT IN (${sqlList(NULLABLE_TENANT_TABLES)})
UNION ALL
SELECT 'platform|' || n.nspname || '.' || c.relname
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND n.nspname IN (${list})
  AND c.relname NOT IN (${sqlList(PLATFORM_TABLES)})
  AND NOT EXISTS (SELECT 1 FROM tenant_tables t WHERE t.oid = c.oid)${ownerCheck}
ORDER BY 1;`;
}

export interface CatalogViolation {
  readonly kind: 'rls' | 'fk' | 'unique' | 'nullable' | 'platform' | 'owner';
  readonly table: string;
  readonly object?: string;
  readonly message: string;
}

export function parseCatalogViolations(output: string): CatalogViolation[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line): CatalogViolation => {
      const [kind = '', table = '', object] = line.split('|');
      if (kind === 'fk') {
        return {
          kind,
          table,
          ...(object === undefined ? {} : { object }),
          message: `FK ${String(object)} em ${table} não inclui tenant_id (FK composta — DEC-081).`,
        };
      }
      if (kind === 'unique') {
        return {
          kind,
          table,
          ...(object === undefined ? {} : { object }),
          message: `Unicidade ${String(object)} em ${table} não inclui tenant_id.`,
        };
      }
      if (kind === 'nullable') {
        return {
          kind,
          table,
          message: `Tabela ${table} aceita tenant_id nulo fora da lista fechada de DEC-080 (V-02).`,
        };
      }
      if (kind === 'platform') {
        return {
          kind,
          table,
          message: `Tabela ${table} sem tenant_id fora da lista fechada de tabelas de plataforma (DEC-080 · V-02).`,
        };
      }
      if (kind === 'owner') {
        return {
          kind,
          table,
          ...(object === undefined ? {} : { object }),
          message: `Tabela ${table} pertence a ${String(object)}, não a ${OWNER_ROLE}: crie os objetos depois de SET ROLE ${OWNER_ROLE} (RN-FND-46).`,
        };
      }
      return {
        kind: 'rls',
        table,
        message: `Migração bloqueada: tabela sem RLS — ${table} tem tenant_id sem RLS ENABLE + FORCE e política.`,
      };
    });
}

export interface ApplyResult {
  readonly ok: boolean;
  readonly applied: readonly string[];
  readonly failed?: { readonly migration: Migration; readonly error: string };
}

/** Aplica em ordem; para na primeira falha e devolve o erro nativo do PostgreSQL. */
export async function applyMigrations(
  pg: Pick<EphemeralPostgres, 'psql'>,
  migrations: readonly Migration[],
  database: string,
): Promise<ApplyResult> {
  const applied: string[] = [];
  for (const item of migrations) {
    const result = await pg.psql(item.sql, { database });
    if (!result.ok) {
      return { ok: false, applied, failed: { migration: item, error: result.stderr } };
    }
    applied.push(item.name);
  }
  return { ok: true, applied };
}

export interface DatabaseCheck {
  /** `do zero` ou `sobre o snapshot <ref>`. */
  readonly label: string;
  readonly apply: ApplyResult;
  /** Falha ao recriar o snapshot (migrações da versão anterior). */
  readonly restoreError?: string;
  readonly catalogError?: string;
  readonly violations: readonly CatalogViolation[];
  readonly ok: boolean;
}

/**
 * Bancos do estágio "Migrações" (RN-FND-25): todas as migrações do PR num banco vazio e, noutro,
 * o *snapshot* da versão publicada (`previous`) seguido das migrações que ela ainda não tinha —
 * a ordem real de um deploy. Cada banco termina com as checagens de catálogo.
 */
export async function verifyMigrations(
  pg: Pick<EphemeralPostgres, 'psql'>,
  current: readonly Migration[],
  previous: readonly Migration[],
  snapshotLabel: string,
): Promise<DatabaseCheck[]> {
  for (const database of ['cf_zero', 'cf_snapshot']) {
    const created = await pg.psql(`CREATE DATABASE ${database} TEMPLATE contrataflow;`);
    if (!created.ok) throw new Error(created.stderr);
  }
  const catalog = async (label: string, apply: ApplyResult, database: string) => {
    if (!apply.ok) return { label, apply, violations: [], ok: false };
    const result = await pg.psql(catalogChecksSql(['public']), { database });
    const violations = result.ok ? parseCatalogViolations(result.stdout) : [];
    return {
      label,
      apply,
      violations,
      ...(result.ok ? {} : { catalogError: result.stderr }),
      ok: result.ok && violations.length === 0,
    };
  };

  const zero = await catalog('do zero', await applyMigrations(pg, current, 'cf_zero'), 'cf_zero');
  const label = `sobre o snapshot ${snapshotLabel}`;
  const restored = await applyMigrations(pg, previous, 'cf_snapshot');
  if (!restored.ok) {
    return [
      zero,
      {
        label,
        apply: restored,
        restoreError: restored.failed?.error ?? '',
        violations: [],
        ok: false,
      },
    ];
  }
  const names = new Set(previous.map((item) => item.name));
  const pending = current.filter((item) => !names.has(item.name));
  return [
    zero,
    await catalog(label, await applyMigrations(pg, pending, 'cf_snapshot'), 'cf_snapshot'),
  ];
}
