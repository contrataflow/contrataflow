// Selos de integridade sobre PostgreSQL real (US-074 · AUD-04/AUD-05): a API inteira como `cf_app`
// (RLS). Os registros da trilha são gravados pelo `AuditService` real (changes, metadata, IP,
// user-agent), os selos são calculados como o worker calcula (rowHash gravado, ordem
// `occurred_at, id`) e a verificação relê o banco e recalcula o rowHash do conteúdo: prova o
// caminho jsonb/inet/enum de ida e volta, a detecção de adulteração direta no banco (com e sem
// `row_hash` recalculado), o 404 para o selo de outro tenant e a RLS de `audit_seals`.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import {
  auditSealListResponseSchema,
  auditSealVerificationResponseSchema,
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

import { rowHashOf } from '../../src/modules/audit/domain/audit-record.js';
import type { AuditRecord } from '../../src/modules/audit/domain/audit-record.js';
import { AuditSeal } from '../../src/modules/audit/domain/audit-seal.js';
import { asTenant, startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';

const id = (suffix: string) => `0192c074-0000-7000-8000-${suffix.padStart(12, '0')}`;
const A = id('a');
const B = id('b');
const CLARA = id('c1');
const BRUNO = id('c2');
const BETO = id('c3');
const MFA = ['pwd', 'otp'];
const HOUR_MS = 3_600_000;

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [CLARA]: ['AUDITOR'],
  [BRUNO]: ['REQUISITANTE'],
  [BETO]: ['AUDITOR'],
};
const SUBJECTS = { clara: 'sub-clara-us074', bruno: 'sub-bruno-us074', beto: 'sub-beto-us074' };

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us074', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us074', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${CLARA}', '${SUBJECTS.clara}', 'clara@us074.test', true, 'Clara Auditora'),
  ('${BRUNO}', '${SUBJECTS.bruno}', 'bruno@us074.test', true, 'Bruno Requisitante'),
  ('${BETO}', '${SUBJECTS.beto}', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status, expires_at) VALUES
  ('${id('d1')}', '${A}', '${CLARA}', 'INTERNAL', 'ACTIVE', NULL),
  ('${id('d2')}', '${A}', '${BRUNO}', 'INTERNAL', 'ACTIVE', NULL),
  ('${id('d3')}', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE', NULL);
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real. */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

interface StoredRow {
  id: string;
  occurred_at: Date;
  row_hash: string;
}

describe('Feature: Selagem de integridade sobre PostgreSQL (US-074)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let counter = 0;
  /** Selos gravados por tenant, em ordem. */
  const chains = new Map<string, AuditSeal[]>();

  const subjectTenant = (subject: string) => (subject === SUBJECTS.beto ? B : A);
  const list = (subject: string = SUBJECTS.clara, query = '') =>
    request(api.server)
      .get(`/api/v1/audit/seals${query}`)
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', subjectTenant(subject));
  const verify = (range: { periodStart: string; periodEnd: string }, subject = SUBJECTS.clara) =>
    request(api.server)
      .post('/api/v1/audit/seals/verify')
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', subjectTenant(subject))
      .send(range);
  const expectProblem = (response: request.Response, status: number, code: string) => {
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    expect(problemDetailsSchema.parse(response.body).code).toBe(code);
  };

  /** Sela, como o worker, cada hora com registros do tenant (rowHash GRAVADO, em ordem). */
  async function sealAll(tenantId: string): Promise<AuditSeal[]> {
    const rows = await db.admin<StoredRow>(
      `SELECT id::text, occurred_at, row_hash FROM audit_logs
        WHERE tenant_id = $1 ORDER BY occurred_at, id`,
      [tenantId],
    );
    const hours = new Map<number, StoredRow[]>();
    for (const row of rows) {
      const hour = Math.floor(row.occurred_at.getTime() / HOUR_MS) * HOUR_MS;
      hours.set(hour, [...(hours.get(hour) ?? []), row]);
    }
    const chain: AuditSeal[] = [];
    for (const [hour, period] of [...hours.entries()].sort(([left], [right]) => left - right)) {
      counter += 1;
      const seal = AuditSeal.create({
        id: id(`5${counter.toString(16).padStart(6, '0')}`),
        tenantId,
        period: { start: new Date(hour), end: new Date(hour + HOUR_MS - 1) },
        previous: chain.at(-1) ?? null,
        records: period.map((row) => ({ id: row.id, rowHash: row.row_hash })),
        sealedAt: new Date(),
      });
      if (!seal) continue;
      await db.admin(
        `INSERT INTO audit_seals (id, tenant_id, period_start, period_end, first_audit_id,
           last_audit_id, record_count, digest, previous_seal_id, chain_hash, sealed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          seal.id,
          tenantId,
          seal.periodStart,
          seal.periodEnd,
          seal.firstAuditId,
          seal.lastAuditId,
          seal.recordCount,
          seal.digest,
          seal.previousSealId,
          seal.chainHash,
          seal.sealedAt,
        ],
      );
      chain.push(seal);
    }
    chains.set(tenantId, chain);
    return chain;
  }

  /** Intervalo que cobre todos os selos do tenant. */
  const rangeOf = (tenantId: string) => {
    const chain = chains.get(tenantId) ?? [];
    return {
      periodStart: (chain[0]?.periodStart ?? new Date()).toISOString(),
      periodEnd: (chain.at(-1)?.periodEnd ?? new Date()).toISOString(),
    };
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

    // Trilha real: o AuditService grava (máscara, JCS, rowHash) — inclusive negação e consulta.
    const audit = api.app.get<AuditTrailPort>(AUDIT_TRAIL);
    await runAsSystem({ name: 'Teste US-074', tenantId: A }, () =>
      audit.recordStandalone({
        action: 'process.update',
        entityType: 'Process',
        entityId: id('f0'),
        processId: id('f0'),
        changes: [
          {
            path: 'title',
            old: 'Aquisição de cimento',
            new: 'Aquisição de cimento CP-II — 2ª fase',
          },
          { path: 'estimatedValue', old: '85000.00', new: 1234.5 },
          {
            path: 'items[0]',
            old: null,
            new: { quantity: 3, unit: 'saco', tags: ['ç', 'ã', '😀'] },
          },
        ],
        metadata: { processCode: '0012/2026', nested: { flag: true, n: -0.25, empty: [] } },
      }),
    );
    await runAsSystem({ name: 'Teste US-074', tenantId: B }, () =>
      audit.recordStandalone({ action: 'process.update', metadata: { leak: 'LEAK-B' } }),
    );
    expectProblem(await list(SUBJECTS.bruno), 403, 'PERMISSION_DENIED');
    expect((await list()).status).toBe(200);
    expect((await list(SUBJECTS.beto)).status).toBe(200);

    await sealAll(A);
    await sealAll(B);
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
  });

  it('a trilha selada tem registros reais do AuditService (alteração, negação e consulta)', async () => {
    const rows = await db.admin<{ row_hash: string; action: string }>(
      `SELECT row_hash, action FROM audit_logs WHERE tenant_id = $1`,
      [A],
    );
    expect(rows.map((row) => row.action)).toEqual(
      expect.arrayContaining(['process.update', 'access.denied', 'audit.search']),
    );
  });

  it('[Sucesso] verificação do intervalo selado → todos VALID (rowHash relido do jsonb/inet)', async () => {
    const response = await verify(rangeOf(A));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const { data } = auditSealVerificationResponseSchema.parse(response.body);
    expect(data.brokenAtPeriodStart).toBeNull();
    expect(data.results.length).toBe(chains.get(A)?.length);
    expect(data.results.every((result) => result.status === 'VALID')).toBe(true);
  });

  it('AUD-04 lista só os selos do tenant (RLS + filtro explícito)', async () => {
    const body = auditSealListResponseSchema.parse((await list()).body);
    const ids = new Set((chains.get(A) ?? []).map((seal) => seal.id));
    expect(body.data.length).toBe(ids.size);
    expect(body.data.every((seal) => ids.has(seal.id))).toBe(true);
    for (const seal of chains.get(B) ?? []) {
      expect(body.data.map((item) => item.id)).not.toContain(seal.id);
    }
  });

  it('[Tenant incorreto] intervalo que só tem selo da Prefeitura B → 404 NOT_FOUND para Clara', async () => {
    const [sealOfB] = chains.get(B) ?? [];
    if (!sealOfB) throw new Error('B sem selo');
    const rangeOfA = new Set((chains.get(A) ?? []).map((seal) => seal.periodStart.getTime()));
    // A hora de B pode coincidir com a de A (mesmo relógio): usa uma hora sem selo de A.
    const hour = rangeOfA.has(sealOfB.periodStart.getTime())
      ? new Date(Math.min(...rangeOfA) - 5 * HOUR_MS)
      : sealOfB.periodStart;
    await db.admin(
      `INSERT INTO audit_seals (id, tenant_id, period_start, period_end, first_audit_id,
         last_audit_id, record_count, digest, chain_hash, sealed_at)
       SELECT $1, $2, $3, $4, first_audit_id, last_audit_id, record_count, digest, chain_hash, now()
         FROM audit_seals WHERE id = $5
       ON CONFLICT DO NOTHING`,
      [id('5bbbbbb'), B, hour, new Date(hour.getTime() + HOUR_MS - 1), sealOfB.id],
    );
    expectProblem(
      await verify({
        periodStart: hour.toISOString(),
        periodEnd: new Date(hour.getTime() + HOUR_MS - 1).toISOString(),
      }),
      404,
      'NOT_FOUND',
    );
    // RLS: com app.tenant_id = A, o cf_app não enxerga nenhum selo de B.
    const app = db.client('cf_app');
    const visible = await asTenant(A, () =>
      app.$tenantTransaction(
        (tx) => tx.$queryRaw<{ tenant_id: string }[]>`
        SELECT DISTINCT tenant_id::text AS tenant_id FROM audit_seals`,
      ),
    );
    expect(visible.map((row) => row.tenant_id)).toEqual([A]);
  });

  it('[Sucesso] AuditLog alterado direto no banco (row_hash intacto) → INVALID no digest daquele período', async () => {
    const [target] = await db.admin<{ id: string; occurred_at: Date }>(
      `SELECT id::text, occurred_at FROM audit_logs
        WHERE tenant_id = $1 AND action = 'process.update'`,
      [A],
    );
    if (!target) throw new Error('registro ausente');
    // Acesso privilegiado: replica desliga o trigger de imutabilidade só nesta sessão.
    await db.admin(
      `SET session_replication_role = replica;
       UPDATE audit_logs SET actor_name = 'Forjado' WHERE id = '${target.id}';`,
    );
    const { data } = auditSealVerificationResponseSchema.parse((await verify(rangeOf(A))).body);
    const hour = new Date(Math.floor(target.occurred_at.getTime() / HOUR_MS) * HOUR_MS);
    expect(data.brokenAtPeriodStart).toBe(hour.toISOString());
    expect(data.results.find((result) => result.periodStart === hour.toISOString())).toMatchObject({
      status: 'INVALID',
      brokenAt: 'digest',
    });
  });

  it('adulteração que também recalcula o row_hash continua detectada (o selo guarda o anterior)', async () => {
    const [target] = await db.admin<AuditRecordRow>(
      `SELECT id::text, occurred_at, tenant_id::text, actor_type::text, actor_user_id::text,
              actor_name, actor_membership_id::text, on_behalf_of_user_id::text, action,
              category::text, result::text, entity_type, entity_id::text, process_id::text,
              changes, metadata, reason_code, host(ip) AS ip, user_agent, correlation_id,
              request_id, session_id_hash
         FROM audit_logs WHERE tenant_id = $1 AND action = 'audit.search' LIMIT 1`,
      [A],
    );
    if (!target) throw new Error('registro ausente');
    const forged: AuditRecord = { ...recordOf(target), metadata: { target: 'forjado' } };
    await db.admin(
      `SET session_replication_role = replica;
       UPDATE audit_logs SET metadata = '{"target":"forjado"}'::jsonb, row_hash = '${rowHashOf(forged)}'
        WHERE id = '${target.id}';`,
    );
    const { data } = auditSealVerificationResponseSchema.parse((await verify(rangeOf(A))).body);
    const hour = new Date(Math.floor(target.occurred_at.getTime() / HOUR_MS) * HOUR_MS);
    expect(data.results.find((result) => result.periodStart === hour.toISOString())).toMatchObject({
      status: 'INVALID',
      brokenAt: 'digest',
    });
  });
});

interface AuditRecordRow {
  id: string;
  occurred_at: Date;
  tenant_id: string | null;
  actor_type: string;
  actor_user_id: string | null;
  actor_name: string | null;
  actor_membership_id: string | null;
  on_behalf_of_user_id: string | null;
  action: string;
  category: string;
  result: string;
  entity_type: string | null;
  entity_id: string | null;
  process_id: string | null;
  changes: AuditRecord['changes'];
  metadata: AuditRecord['metadata'];
  reason_code: string | null;
  ip: string | null;
  user_agent: string | null;
  correlation_id: string | null;
  request_id: string | null;
  session_id_hash: string | null;
}

function recordOf(row: AuditRecordRow): AuditRecord {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    tenantId: row.tenant_id,
    actorType: row.actor_type as AuditRecord['actorType'],
    actorUserId: row.actor_user_id,
    actorName: row.actor_name,
    actorMembershipId: row.actor_membership_id,
    onBehalfOfUserId: row.on_behalf_of_user_id,
    action: row.action as AuditRecord['action'],
    category: row.category as AuditRecord['category'],
    result: row.result as AuditRecord['result'],
    entityType: row.entity_type,
    entityId: row.entity_id,
    processId: row.process_id,
    changes: row.changes,
    metadata: row.metadata,
    reasonCode: row.reason_code,
    ip: row.ip,
    userAgent: row.user_agent,
    correlationId: row.correlation_id,
    requestId: row.request_id,
    sessionIdHash: row.session_id_hash,
  };
}
