// Cenário "tenant leak" básico do smoke (US-078 — Gherkin "[Tenant incorreto]"): com o papel sem
// BYPASSRLS e o contexto de um tenant, nenhuma linha do outro tenant é visível; sem contexto, a
// consulta falha fechada (DEC-082).
import { seedId } from '../seed/dataset.js';
import { SEED_READER_ROLE, SEED_SCHEMA, sqlLiteral, TENANT_TABLES } from '../seed/sql.js';

export interface LeakCounts {
  /** Linhas de outros tenants visíveis sob o contexto (deve ser 0). */
  readonly foreign: number;
  /** Linhas do próprio tenant visíveis (deve ser > 0). */
  readonly own: number;
  /** Vínculos ativos do usuário visíveis sob o contexto. */
  readonly userMemberships: number;
}

/** Consulta, como `dev_seed_reader` sob `app.tenant_id = tenantSlug`, o que fica visível. */
export function leakQuerySql(tenantSlug: string, userId: string): string {
  const tenantId = sqlLiteral(seedId(tenantSlug, 'tenant'));
  const foreign = TENANT_TABLES.map(
    (table) => `(SELECT count(*) FROM ${SEED_SCHEMA}.${table} WHERE tenant_id <> ${tenantId})`,
  ).join(' + ');
  const own = TENANT_TABLES.map((table) => `(SELECT count(*) FROM ${SEED_SCHEMA}.${table})`).join(
    ' + ',
  );
  return [
    'BEGIN;',
    `SET LOCAL ROLE ${SEED_READER_ROLE};`,
    `SELECT set_config('app.tenant_id', ${tenantId}, true) \\g /dev/null`,
    `SELECT json_build_object('foreign', ${foreign}, 'own', ${own}, 'userMemberships', (SELECT count(*) FROM ${SEED_SCHEMA}.tenant_memberships WHERE user_id = ${sqlLiteral(userId)} AND status = 'ACTIVE'))::text;`,
    'ROLLBACK;',
  ].join('\n');
}

/** Sem `app.tenant_id` definido: deve falhar ("unrecognized configuration parameter"). */
export function noContextSql(): string {
  return [
    'BEGIN;',
    `SET LOCAL ROLE ${SEED_READER_ROLE};`,
    `SELECT count(*) FROM ${SEED_SCHEMA}.organizations;`,
    'ROLLBACK;',
  ].join('\n');
}

/** Visão de plataforma (seletor de tenant): tenants com vínculo ativo do usuário. */
export function userTenantsSql(userId: string): string {
  return `SELECT coalesce(string_agg(t.name, ',' ORDER BY t.name), '') FROM ${SEED_SCHEMA}.tenant_memberships m JOIN ${SEED_SCHEMA}.tenants t ON t.id = m.tenant_id WHERE m.user_id = ${sqlLiteral(userId)} AND m.status = 'ACTIVE' AND t.status = 'ACTIVE';`;
}

/** `sub` registrado para o login (liga o token OIDC ao usuário semeado). */
export function externalSubjectSql(userId: string): string {
  return `SELECT coalesce(external_subject, '') FROM ${SEED_SCHEMA}.users WHERE id = ${sqlLiteral(userId)};`;
}
