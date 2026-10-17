// Consulta e exportação da trilha sobre PostgreSQL real (US-075 · AUD-01/02/03): a API inteira
// como `cf_app` (RLS). Os registros "de verdade" vêm do `AuditService` real (máscara, jsonb, inet);
// os volumosos entram por SQL (generate_series) na partição do mês corrente. Prova o isolamento por
// tenant (lista, detalhe → 404 idêntico ao inexistente, exportação e RLS), a poda de partições
// pelo período obrigatório, a exportação em lotes por cursor (sem repetir nem pular, com empates de
// `occurred_at`), o teto `EXPORT_TOO_LARGE` e exportações simultâneas com filtros diferentes.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import {
  auditLogResponseSchema,
  auditLogSearchResponseSchema,
  problemDetailsSchema,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';
import { runAsSystem } from '#shared/context/request-context.js';

import { auditCriteriaOf } from '../../src/modules/audit/domain/audit-log-query.js';
import { buildAuditSearchSql } from '../../src/modules/audit/infrastructure/prisma-audit-log.store.js';
import { asTenant, startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';

const id = (suffix: string) => `0192c075-0000-7000-8000-${suffix.padStart(12, '0')}`;
const A = id('a');
const B = id('b');
const CLARA = id('c1');
const BETO = id('c3');
const MFA = ['pwd', 'otp'];
const SUBJECTS = { clara: 'sub-clara-us075', beto: 'sub-beto-us075' };
const ROLES: Readonly<Record<string, readonly string[]>> = {
  [CLARA]: ['AUDITOR'],
  [BETO]: ['AUDITOR'],
};
const ENTITY_OF_B = id('e0b');
const EXPORT_MAX_ROWS = 3_000;
/** Linhas do lote de *streaming* (mais de dois lotes de 1.000) e do lote acima do teto. */
const STREAM_ROWS = 2_600;
const BULK_ROWS = EXPORT_MAX_ROWS + 100;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us075', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us075', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${CLARA}', '${SUBJECTS.clara}', 'clara@us075.test', true, 'Clara Auditora'),
  ('${BETO}', '${SUBJECTS.beto}', 'beto@b075.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status, expires_at) VALUES
  ('${id('d1')}', '${A}', '${CLARA}', 'INTERNAL', 'ACTIVE', NULL),
  ('${id('d3')}', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE', NULL);
`;

/**
 * Registros em massa do tenant, na partição do mês corrente: 7 por milissegundo (empates de
 * `occurred_at` que o cursor desfaz pelo id), nunca antes do início do mês.
 */
const bulkSql = (tenantId: string, prefix: string, rows: number, entityType: string) => `
INSERT INTO audit_logs (id, occurred_at, tenant_id, actor_type, actor_name, action, category,
                        result, entity_type, metadata, row_hash)
SELECT ('0192c075-${prefix}-7000-8000-' || lpad(to_hex(i), 12, '0'))::uuid,
       greatest(date_trunc('month', now()), date_trunc('second', now()) - (i / 7) * interval '1 millisecond'),
       '${tenantId}'::uuid, 'SYSTEM', '=SOMA(' || i || ')', 'process.update', 'DATA_CHANGE',
       'SUCCESS', '${entityType}', jsonb_build_object('n', i), repeat('0', 64)
  FROM generate_series(1, ${String(rows)}) AS i`;

class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

describe('Feature: Consulta e exportação da trilha sobre PostgreSQL (US-075)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let period: { occurredFrom: string; occurredTo: string };
  let recordOfA: string;
  let recordOfB: string;

  const subjectTenant = (subject: string) => (subject === SUBJECTS.beto ? B : A);
  const call = (path: string, subject: string = SUBJECTS.clara) =>
    request(api.server)
      .get(`/api/v1/audit${path}`)
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', subjectTenant(subject))
      .buffer(true)
      .parse((response, callback) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
        });
        response.on('end', () => {
          callback(null, text);
        });
      });
  const text = (response: request.Response) => response.body as string;
  const query = (params: Record<string, string>) =>
    `?${new URLSearchParams({ ...period, ...params }).toString()}`;
  const ndjson = (response: request.Response) =>
    text(response)
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { id: string; occurredAt: string; entityType: string });
  const expectProblem = (response: request.Response, status: number, code: string) => {
    expect(response.status, text(response)).toBe(status);
    const body = problemDetailsSchema.parse(JSON.parse(text(response)));
    expect(body.code).toBe(code);
    return body;
  };

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    db = await startTestDatabase();
    await db.admin(FIXTURE_SQL);
    const membership = new RoleInjectingMembershipPort();
    const config = testConfig({
      OIDC_FAKE_SIGNING_KEY: '',
      DATABASE_URL: db.url('cf_app'),
      DATABASE_URL_PLATFORM: db.url('cf_platform'),
      AUDIT_EXPORT_MAX_ROWS: String(EXPORT_MAX_ROWS),
    });
    api = await createTestApi({
      config,
      providers: [
        { token: MEMBERSHIP_PORT, value: membership },
        {
          token: TOKEN_VERIFIER,
          value: new FakeJwksProvider({
            signingKey: TEST_SIGNING_KEY,
            issuer: TEST_ISSUER,
            audiences: config.oidc.audiences,
            clockToleranceSeconds: 30,
          }),
        },
      ],
    });
    membership.inner = api.app.get(PrismaIdentityRepository);

    const audit = api.app.get<AuditTrailPort>(AUDIT_TRAIL);
    await runAsSystem({ name: 'Teste US-075', tenantId: A }, () =>
      audit.recordStandalone({
        action: 'supplier.update',
        entityType: 'Supplier',
        entityId: id('e0a'),
        changes: [
          { path: 'contactCpf', old: '123.456.789-09', new: '987.654.321-00' },
          { path: 'notes', old: null, new: 'y'.repeat(700) },
        ],
        metadata: { supplierName: 'Cimentos do Sul' },
      }),
    );
    await runAsSystem({ name: 'Teste US-075', tenantId: B }, () =>
      audit.recordStandalone({
        action: 'supplier.update',
        entityType: 'Supplier',
        entityId: ENTITY_OF_B,
        metadata: { leak: 'LEAK-B' },
      }),
    );
    await db.admin(bulkSql(A, '0a00', STREAM_ROWS, 'Stream'));
    await db.admin(bulkSql(A, '0b00', BULK_ROWS, 'Bulk'));
    await db.admin(bulkSql(B, '0c00', 50, 'Stream'));

    const [ofA] = await db.admin<{ id: string }>(
      `SELECT id::text FROM audit_logs WHERE tenant_id = $1 AND action = 'supplier.update'`,
      [A],
    );
    const [ofB] = await db.admin<{ id: string }>(
      `SELECT id::text FROM audit_logs WHERE tenant_id = $1 AND action = 'supplier.update'`,
      [B],
    );
    if (!ofA || !ofB) throw new Error('registros de referência ausentes');
    recordOfA = ofA.id;
    recordOfB = ofB.id;
    const [bounds] = await db.admin<{ start: Date }>(`SELECT date_trunc('month', now()) AS start`);
    period = {
      occurredFrom: (bounds?.start ?? new Date()).toISOString(),
      occurredTo: new Date(Date.now() + 60_000).toISOString(),
    };
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
  });

  it('[Tenant incorreto] AUD-01 devolve só registros do tenant, mesmo com filtros que casam os de B', async () => {
    const response = await call(query({ action: 'supplier.update', limit: '100' }));
    expect(response.status, text(response)).toBe(200);
    const body = auditLogSearchResponseSchema.parse(JSON.parse(text(response)));
    expect(body.data.map((item) => item.id)).toEqual([recordOfA]);
    expect(text(response)).not.toContain('LEAK-B');
    const byEntityOfB = auditLogSearchResponseSchema.parse(
      JSON.parse(text(await call(query({ entityType: 'Supplier', entityId: ENTITY_OF_B })))),
    );
    expect(byEntityOfB.data).toEqual([]);
  });

  it('[Tenant incorreto] AUD-02 com registro de B → 404 igual ao inexistente; o de A volta do jsonb/inet mascarado', async () => {
    const leaked = expectProblem(await call(`/${recordOfB}`), 404, 'NOT_FOUND');
    const missing = expectProblem(await call(`/${id('dead')}`), 404, 'NOT_FOUND');
    expect({ ...leaked, instance: null, correlationId: null }).toEqual({
      ...missing,
      instance: null,
      correlationId: null,
    });
    const response = await call(`/${recordOfA}`);
    expect(response.status, text(response)).toBe(200);
    const { data } = auditLogResponseSchema.parse(JSON.parse(text(response)));
    expect(data.changes?.[0]).toEqual({
      path: 'contactCpf',
      old: '***.456.789-**',
      new: '***.654.321-**',
    });
    expect(data.changes?.[1]?.new).toMatchObject({ length: 700 });
    expect(text(response)).not.toContain('123.456.789-09');
    expect(data.rowHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('RLS: com app.tenant_id = A, o cf_app não lê nenhuma linha de B em audit_logs', async () => {
    const app = db.client('cf_app');
    const visible = await asTenant(A, () =>
      app.$tenantTransaction(
        (tx) => tx.$queryRaw<{ tenant_id: string }[]>`
          SELECT DISTINCT tenant_id::text AS tenant_id FROM audit_logs`,
      ),
    );
    expect(visible.map((row) => row.tenant_id)).toEqual([A]);
  });

  it('o período obrigatório poda as partições mensais fora do intervalo (RN-AUD-17)', async () => {
    const [months] = await db.admin<{ current: string; next: string }>(
      `SELECT 'audit_logs_' || to_char(now() AT TIME ZONE 'UTC', 'YYYY_MM') AS current,
              'audit_logs_' || to_char((now() AT TIME ZONE 'UTC') + interval '1 month', 'YYYY_MM') AS next`,
    );
    const sql = buildAuditSearchSql({
      ...auditCriteriaOf(A, { ...period, action: ['process.update'] }),
      after: null,
      take: 51,
    });
    const plan = await db.admin<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql.text}`, sql.values);
    const text = plan.map((row) => row['QUERY PLAN']).join('\n');
    expect(text).toContain(months?.current);
    expect(text).not.toContain(months?.next);
  });

  it('[Sucesso] exportação em lotes: todas as linhas do filtro, uma vez cada, na ordem da consulta', async () => {
    const response = await call(`/export${query({ entityType: 'Stream', format: 'ndjson' })}`);
    expect(response.status, text(response)).toBe(200);
    const rows = ndjson(response);
    expect(rows).toHaveLength(STREAM_ROWS);
    expect(new Set(rows.map((row) => row.id)).size).toBe(STREAM_ROWS);
    const order = rows.map((row) => [Date.parse(row.occurredAt), row.id] as const);
    for (let index = 1; index < order.length; index += 1) {
      const [previousTime, previousId] = order[index - 1] ?? [0, ''];
      const [time, rowId] = order[index] ?? [0, ''];
      expect(time < previousTime || (time === previousTime && rowId < previousId)).toBe(true);
    }
    const csv = text(await call(`/export${query({ entityType: 'Stream' })}`));
    expect(csv).toContain(",'=SOMA(1),");
    expect(csv.split('\r\n').filter((line) => line !== '')).toHaveLength(1 + STREAM_ROWS);
  });

  it('[Falha de integração] acima do teto → 422 EXPORT_TOO_LARGE com a contagem, antes de gerar o arquivo', async () => {
    const body = expectProblem(
      await call(`/export${query({ entityType: 'Bulk' })}`),
      422,
      'EXPORT_TOO_LARGE',
    );
    expect(body.detail).toBe(
      `Muitos registros para exportar (${BULK_ROWS.toLocaleString('pt-BR')}). Refine o período ou os filtros.`,
    );
  });

  it('[Concorrência] exportações simultâneas com filtros diferentes não se misturam', async () => {
    const [stream, supplier, ofB] = await Promise.all([
      call(`/export${query({ entityType: 'Stream', format: 'ndjson' })}`),
      call(`/export${query({ entityType: 'Supplier', format: 'ndjson' })}`),
      call(`/export${query({ entityType: 'Stream', format: 'ndjson' })}`, SUBJECTS.beto),
    ]);
    const types = (response: request.Response) =>
      new Set(ndjson(response).map((r) => r.entityType));
    expect(ndjson(stream)).toHaveLength(STREAM_ROWS);
    expect(types(stream)).toEqual(new Set(['Stream']));
    expect(ndjson(supplier).map((row) => row.id)).toEqual([recordOfA]);
    expect(ndjson(ofB)).toHaveLength(50);
    const auditOfA = await db.admin<{ count: number }>(
      `SELECT count(*)::int AS count FROM audit_logs WHERE tenant_id = $1 AND action = 'audit.export'`,
      [A],
    );
    expect(auditOfA[0]?.count).toBeGreaterThanOrEqual(4);
  });
});
