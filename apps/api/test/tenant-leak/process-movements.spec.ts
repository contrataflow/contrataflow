// Histórico de tramitações sobre PostgreSQL real (US-054 · PRC-11): a API inteira como `cf_app`
// (RLS) com os seeders do provisionamento e processos/tramitações inseridos pelo superusuário. Prova
// o SQL de `PrismaProcessRepository.listMovements`: ordem `sequence DESC`, filtros combinados, `ip`
// (inet) só com AUDIT_VIEW, nomes hidratados em lote só do próprio tenant, cursor estável com 1.000
// tramitações e inserções concorrentes, o índice no plano, processo de outro tenant → 404 sem
// revelar nada, cursor e filtros com ids de B sem efeito e a RLS de process_movements com outro
// `app.tenant_id`. `pnpm --filter @contrataflow/api test:tenant-leak`.
import { problemDetailsSchema, processMovementsResponseSchema } from '@contrataflow/validation';
import type { ProcessMovementsResponse } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
import { asTenant, startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';
import { runTenantSeeders } from '../support/process-fixtures.js';

const id = (suffix: string) => `0192c054-0000-7000-8000-${suffix.padStart(12, '0')}`;
const A = id('a');
const B = id('b');
const ORG_A = id('a0');
const ORG_B = id('b0');
const OBRAS = id('a1');
const MANUTENCAO = id('a2');
const COTACOES = id('a3');
const OBRAS_B = id('b1');
const SETOR_X = id('b2');
const ANA = id('c1');
const RAFAEL = id('c2');
const CARLOS = id('c3');
const BETO = id('c4');
/** 0012: 5 tramitações (CREATE, FORWARD, RETURN, FORWARD, APPROVE). */
const P12 = id('12');
/** 0040: 1.000 tramitações e as inserções concorrentes. */
const P40 = id('40');
const P_B = id('bf');
const NOW = new Date('2026-10-05T15:00:00.000Z');
const MFA = ['pwd', 'otp'];
const IP = '200.10.20.30';

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [RAFAEL]: ['CONTROLE_INTERNO'],
  [CARLOS]: [],
  [BETO]: ['GESTOR_CONTRATACOES'],
};
const SUBJECTS = {
  ana: 'sub-ana-us054',
  rafael: 'sub-rafael-us054',
  carlos: 'sub-carlos-us054',
  beto: 'sub-beto-us054',
} as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us054', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us054', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth, is_active) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0, true),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1, true),
  ('${COTACOES}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Cotações', '${path(OBRAS, COTACOES)}', 1, false),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Obras LEAK-B', '${path(OBRAS_B)}', 0, true),
  ('${SETOR_X}', '${B}', '${ORG_B}', '${OBRAS_B}', 'SECTOR', 'Setor X LEAK-B', '${path(OBRAS_B, SETOR_X)}', 1, true);
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', '${SUBJECTS.ana}', 'ana@us054.test', true, 'Ana Souza'),
  ('${RAFAEL}', '${SUBJECTS.rafael}', 'rafael@us054.test', true, 'Rafael Nogueira'),
  ('${CARLOS}', '${SUBJECTS.carlos}', 'carlos@us054.test', true, 'Carlos Lima'),
  ('${BETO}', '${SUBJECTS.beto}', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status, expires_at) VALUES
  ('${id('d1')}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE', NULL),
  ('${id('d2')}', '${A}', '${RAFAEL}', 'INTERNAL', 'ACTIVE', NULL),
  ('${id('d3')}', '${A}', '${CARLOS}', 'INTERNAL', 'ACTIVE', NULL),
  ('${id('d4')}', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE', NULL);
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('${id('e1')}', '${A}', '${id('d1')}', '${MANUTENCAO}', true);
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real (atribuições: US-096). */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

interface SeedMovement {
  readonly processId: string;
  readonly sequence: number;
  readonly action: string;
  readonly from?: string | null;
  readonly to?: string | null;
  readonly actorId?: string;
  readonly comment?: string | null;
  readonly occurredAt: string;
  readonly tenantId?: string;
}

describe('Feature: Histórico de tramitações sobre PostgreSQL (US-054)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let counter = 0;

  const tenantOf = (subject: string): string => (subject === SUBJECTS.beto ? B : A);
  const get = (processId: string, query = '', subject: string = SUBJECTS.ana) =>
    request(api.server)
      .get(`/api/v1/processes/${processId}/movements${query}`)
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));
  const list = async (
    processId: string,
    query = '',
    subject: string = SUBJECTS.ana,
  ): Promise<ProcessMovementsResponse> => {
    const response = await get(processId, query, subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return processMovementsResponseSchema.parse(response.body);
  };
  const sequences = (body: ProcessMovementsResponse) => body.data.map((item) => item.sequence);
  const expectProblem = (response: request.Response, status: number, code: string) => {
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    expect(problemDetailsSchema.parse(response.body).code).toBe(code);
  };

  async function insertProcess(process: {
    readonly id: string;
    readonly number: number;
    readonly tenantId?: string;
    readonly organizationId?: string;
    readonly secretariat?: string;
    readonly department?: string;
    readonly title?: string;
  }): Promise<void> {
    const tenantId = process.tenantId ?? A;
    await db.admin(
      `INSERT INTO processes (
         id, tenant_id, organization_id, number, year, code, title, object, contracting_type_id,
         requesting_secretariat_id, requesting_department_id, current_department_id,
         priority, status, workflow_version_id, current_workflow_stage_id,
         is_budget_confidential, origin_id, pca_status, created_by_id, created_at, updated_at)
       SELECT $1::uuid, $2::uuid, $3::uuid, $4::int, 2026, lpad($4::int::text, 4, '0') || '/2026', $5,
              'Objeto do processo de teste.',
              (SELECT id FROM catalog_items WHERE tenant_id = $2 AND catalog_type = 'CONTRACTING_TYPE' AND code = 'AQUISICAO_BENS'),
              $6::uuid, $7::uuid, $7::uuid, 'HIGH'::priority, 'IN_PROGRESS'::process_status,
              s.workflow_version_id, s.id, false,
              (SELECT id FROM catalog_items WHERE tenant_id = $2 AND catalog_type = 'PROCESS_ORIGIN' AND code = 'DEMANDA_NAO_PREVISTA'),
              'NOT_APPLICABLE', $8::uuid, '2026-09-01T12:00:00Z', '2026-09-05T12:00:00Z'
         FROM workflow_stages s
         JOIN workflow_versions v ON v.id = s.workflow_version_id AND v.status = 'PUBLISHED'
        WHERE s.tenant_id = $2::uuid AND s.key = 'ABERTURA'
        LIMIT 1`,
      [
        process.id,
        tenantId,
        process.organizationId ?? ORG_A,
        process.number,
        process.title ?? `Processo ${process.number}`,
        process.secretariat ?? OBRAS,
        process.department ?? MANUTENCAO,
        tenantId === A ? ANA : BETO,
      ],
    );
  }

  async function grant(processId: string, department: string, reason: string, tenantId = A) {
    counter += 1;
    await db.admin(
      `INSERT INTO process_access (id, tenant_id, process_id, principal_type, department_id, reason)
       VALUES ($1, $2, $3, 'DEPARTMENT', $4, $5::process_access_reason)`,
      [id(`ac${counter}`), tenantId, processId, department, reason],
    );
  }

  /** Tramitação como as stories de escrita a gravam (só INSERT — gatilho append-only). */
  async function insertMovement(movement: SeedMovement): Promise<void> {
    counter += 1;
    const tenantId = movement.tenantId ?? A;
    await db.admin(
      `INSERT INTO process_movements (
         id, tenant_id, process_id, sequence, action, to_workflow_stage_id, from_department_id,
         to_department_id, status_to, actor_type, actor_id, comment, ip, user_agent, correlation_id,
         occurred_at)
       SELECT $1::uuid, $2::uuid, $3::uuid, $4::int, $5::movement_action, p.current_workflow_stage_id,
              $6::uuid, $7::uuid, 'IN_PROGRESS'::process_status, 'USER'::actor_type, $8::uuid, $9,
              $10::inet, 'vitest', $11, $12::timestamptz
         FROM processes p WHERE p.id = $3::uuid`,
      [
        id(`f${counter.toString(16).padStart(7, '0')}`),
        tenantId,
        movement.processId,
        movement.sequence,
        movement.action,
        movement.from ?? null,
        movement.to ?? null,
        movement.actorId ?? (tenantId === A ? ANA : BETO),
        movement.comment ?? null,
        IP,
        `corr-${String(counter)}`,
        movement.occurredAt,
      ],
    );
  }

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
        { token: CATALOG_CLOCK, value: () => NOW },
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
    await runTenantSeeders(api, A);
    await runTenantSeeders(api, B);

    await insertProcess({ id: P12, number: 12 });
    await grant(P12, MANUTENCAO, 'REQUESTING');
    await insertProcess({ id: P40, number: 40 });
    await grant(P40, MANUTENCAO, 'REQUESTING');
    await insertProcess({
      id: P_B,
      number: 7,
      tenantId: B,
      organizationId: ORG_B,
      secretariat: OBRAS_B,
      department: SETOR_X,
      title: 'Processo LEAK-B',
    });
    await grant(P_B, SETOR_X, 'CURRENT', B);

    const at = (day: number) => `2026-09-0${String(day)}T12:00:00Z`;
    await insertMovement({
      processId: P12,
      sequence: 1,
      action: 'CREATE',
      to: MANUTENCAO,
      occurredAt: at(1),
    });
    await insertMovement({
      processId: P12,
      sequence: 2,
      action: 'FORWARD',
      from: MANUTENCAO,
      to: COTACOES,
      comment: 'Segue para cotação.',
      occurredAt: at(2),
    });
    await insertMovement({
      processId: P12,
      sequence: 3,
      action: 'RETURN',
      from: COTACOES,
      to: MANUTENCAO,
      actorId: RAFAEL,
      comment: 'Falta a especificação.',
      occurredAt: at(3),
    });
    await insertMovement({
      processId: P12,
      sequence: 4,
      action: 'FORWARD',
      from: MANUTENCAO,
      to: COTACOES,
      occurredAt: at(4),
    });
    await insertMovement({
      processId: P12,
      sequence: 5,
      action: 'APPROVE',
      from: COTACOES,
      to: COTACOES,
      occurredAt: at(5),
    });
    await insertMovement({
      processId: P_B,
      sequence: 1,
      action: 'CREATE',
      to: SETOR_X,
      comment: 'LEAK-B',
      occurredAt: at(1),
      tenantId: B,
    });
    // 1.000 tramitações pré-existentes no 0040 (DoD: paginação estável sob concorrência).
    await db.admin(
      `INSERT INTO process_movements (
         id, tenant_id, process_id, sequence, action, to_workflow_stage_id, to_department_id,
         status_to, actor_type, actor_id, correlation_id, occurred_at)
       SELECT gen_random_uuid(), $1::uuid, $2::uuid, n,
              (CASE WHEN n = 1 THEN 'CREATE' ELSE 'FORWARD' END)::movement_action,
              p.current_workflow_stage_id, $3::uuid, 'IN_PROGRESS'::process_status,
              'USER'::actor_type, $4::uuid, 'bulk-' || n,
              '2026-08-01T00:00:00Z'::timestamptz + n * interval '1 minute'
         FROM generate_series(1, 1000) AS n, processes p WHERE p.id = $2::uuid`,
      [A, P40, MANUTENCAO, ANA],
    );
    await db.admin('ANALYZE process_movements');
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
    await db.stop();
  });

  it('[Sucesso] ordem sequence DESC, nomes hidratados e ip nulo sem AUDIT_VIEW', async () => {
    const body = await list(P12);
    expect(sequences(body)).toEqual([5, 4, 3, 2, 1]);
    expect(body.meta).toEqual({ nextCursor: null, hasMore: false, canViewIp: false });
    const forwarded = body.data.find((item) => item.sequence === 2);
    expect(forwarded).toMatchObject({
      action: 'FORWARD',
      fromDepartment: { id: MANUTENCAO, name: 'Setor de Manutenção', isActive: true },
      // FA-05: unidade inativada mantém o nome histórico.
      toDepartment: { id: COTACOES, name: 'Setor de Cotações', isActive: false },
      actor: { type: 'USER', id: ANA, name: 'Ana Souza' },
      comment: 'Segue para cotação.',
      occurredAt: '2026-09-02T12:00:00.000Z',
      ip: null,
    });
    expect(forwarded?.toStage?.name).toEqual(expect.any(String));
    expect(body.data.find((item) => item.sequence === 3)?.actor.name).toBe('Rafael Nogueira');
  });

  it('[Sucesso] filtros combinados no SQL (ação por OU; unidade, ator e período por E)', async () => {
    expect(sequences(await list(P12, '?action=FORWARD,APPROVE'))).toEqual([5, 4, 2]);
    expect(sequences(await list(P12, `?action=FORWARD&toDepartmentId=${COTACOES}`))).toEqual([
      4, 2,
    ]);
    expect(sequences(await list(P12, `?fromDepartmentId=${COTACOES}`))).toEqual([5, 3]);
    expect(sequences(await list(P12, `?actorId=${RAFAEL}`))).toEqual([3]);
    expect(
      sequences(
        await list(P12, '?occurredFrom=2026-09-02T12:00:00Z&occurredTo=2026-09-03T12:00:00Z'),
      ),
    ).toEqual([3, 2]);
  });

  it('[Permissão] com AUDIT_VIEW o ip (inet) vem como texto; sem visibilidade → 404 e access.denied', async () => {
    const audited = await list(P12, '', SUBJECTS.rafael);
    expect(audited.meta.canViewIp).toBe(true);
    expect(audited.data.map((item) => item.ip)).toEqual([IP, IP, IP, IP, IP]);

    expectProblem(await get(P12, '', SUBJECTS.carlos), 404, 'PROCESS_NOT_FOUND');
    const audits = await db.admin<{ reason_code: string | null }>(
      "SELECT reason_code FROM audit_logs WHERE tenant_id = $1 AND action = 'access.denied' AND actor_user_id = $2",
      [A, CARLOS],
    );
    expect(audits.length).toBeGreaterThan(0);
  });

  it('[Tenant incorreto] processo de B → 404; cursor e filtros com dados de B sem efeito; RLS isola', async () => {
    const response = await get(P_B);
    expectProblem(response, 404, 'PROCESS_NOT_FOUND');
    expect(JSON.stringify(response.body)).not.toContain('LEAK-B');

    const forged = Buffer.from(JSON.stringify({ s: 2 })).toString('base64url');
    const page = await list(P12, `?cursor=${forged}`);
    expect(sequences(page)).toEqual([1]);
    expect(JSON.stringify(page)).not.toContain('LEAK-B');
    expect((await list(P12, `?toDepartmentId=${SETOR_X}`)).data).toEqual([]);

    // B só vê o próprio processo, com os nomes do próprio tenant.
    const own = await list(P_B, '', SUBJECTS.beto);
    expect(own.data.map((item) => item.toDepartment?.name)).toEqual(['Setor X LEAK-B']);

    const client = db.client('cf_app');
    try {
      const seen = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) =>
            tx.$queryRaw<
              { id: string }[]
            >`SELECT id FROM process_movements WHERE process_id = ${P12}::uuid`,
        ),
      );
      expect(seen).toEqual([]);
    } finally {
      await client.$disconnect();
    }
  });

  it('[Duplicidade] a mesma página repetida devolve o mesmo resultado e não grava nada', async () => {
    const [before] = await db.admin<{ count: string }>(
      'SELECT count(*)::text AS count FROM process_movements',
    );
    const first = await list(P12, '?limit=3');
    expect(await list(P12, '?limit=3')).toEqual(first);
    const [after] = await db.admin<{ count: string }>(
      'SELECT count(*)::text AS count FROM process_movements',
    );
    expect(after?.count).toBe(before?.count);
  });

  it('o plano da consulta usa índice (sem varredura sequencial) com 1.000 tramitações', async () => {
    const plan = await db.admin<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT * FROM process_movements
        WHERE tenant_id = $1::uuid AND process_id = $2::uuid AND sequence < 500
        ORDER BY sequence DESC LIMIT 51`,
      [A, P40],
    );
    const text = plan.map((row) => row['QUERY PLAN']).join('\n');
    expect(text).toMatch(/Index/);
    expect(text).not.toContain('Seq Scan on process_movements');
  });

  it('[Concorrência] 1.000 tramitações + inserções durante a paginação: nada repetido nem omitido', async () => {
    const first = await list(P40, '?limit=100');
    expect(sequences(first)[0]).toBe(1000);
    const seen = [...sequences(first)];
    let cursor = first.meta.nextCursor;
    let next = 1001;
    while (cursor !== null) {
      const [page] = await Promise.all([
        list(P40, `?limit=100&cursor=${encodeURIComponent(cursor)}`),
        insertMovement({
          processId: P40,
          sequence: next,
          action: 'FORWARD',
          to: COTACOES,
          occurredAt: '2026-10-05T14:30:00Z',
        }),
      ]);
      next += 1;
      seen.push(...sequences(page));
      cursor = page.meta.nextCursor;
    }
    expect(seen).toEqual(Array.from({ length: 1000 }, (_, index) => 1000 - index));
    const restart = await list(P40, '?limit=5');
    expect(sequences(restart)[0]).toBe(next - 1);
  });
});
