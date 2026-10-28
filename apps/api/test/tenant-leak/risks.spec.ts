// Riscos sobre PostgreSQL real (US-033 · Sucesso, Tenant incorreto, Concorrência, Falha de banco,
// Falha de integração): a API inteira como `cf_app` (RLS) com os seeders reais do provisionamento,
// o processo criado pelo PRC-02 e levado à etapa "ETP e mapa de riscos", e os riscos pelos
// RSK-01..05. Prova a trava de numeração por processo (`pg_advisory_xact_lock` — códigos R01..R10
// sem repetição em criações paralelas de duas pessoas com custódia pela fila da unidade), o código
// nunca reaproveitado depois da exclusão, a cascata lógica dos tratamentos, a transação única por
// falha induzida DEPOIS de gravar o risco (nada persiste: risco, timeline, auditoria e outbox), os
// eventos `PENDING`, os checks de banco (`score = probability * impact`) e a RLS (risco e categoria
// de outro tenant). `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { ProcessDto, RiskDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
import { PROCESS_CLOCK } from '../../src/modules/process/application/ports.js';
import { RISK_CLOCK } from '../../src/modules/risk/application/ports.js';
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

const A = '0192c033-0000-7000-8000-00000000010a';
const B = '0192c033-0000-7000-8000-00000000010b';
const ORG_A = '0192c033-0000-7000-8000-0000000010a0';
const ORG_B = '0192c033-0000-7000-8000-0000000010b0';
const OBRAS = '0192c033-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c033-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c033-0000-7000-8000-0000000010b1';
const ANA = '0192c033-0000-7000-8000-0000000010c1';
const CARLA = '0192c033-0000-7000-8000-0000000010c2';
const BETO = '0192c033-0000-7000-8000-0000000010c3';
const ANA_M = '0192c033-0000-7000-8000-0000000010d1';
const CARLA_M = '0192c033-0000-7000-8000-0000000010d2';
const NOW = new Date('2026-10-17T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [CARLA]: ['REQUISITANTE'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const SUBJECTS = {
  ana: 'sub-ana-us033',
  carla: 'sub-carla-us033',
  beto: 'sub-beto-us033',
} as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us033', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us033', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Obras LEAK-B', '${path(OBRAS_B)}', 0);
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', '${SUBJECTS.ana}', 'ana@a.test', true, 'Ana Souza'),
  ('${CARLA}', '${SUBJECTS.carla}', 'carla@a.test', true, 'Carla Dias'),
  ('${BETO}', '${SUBJECTS.beto}', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('${CARLA_M}', '${A}', '${CARLA}', 'INTERNAL', 'ACTIVE'),
  ('0192c033-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c033-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true),
  ('0192c033-0000-7000-8000-0000000010e2', '${A}', '${CARLA_M}', '${MANUTENCAO}', true);
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real (atribuições: US-096). */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

type Row = Readonly<Record<string, unknown>>;

const words = (count: number) =>
  Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

describe('Feature: Registrar e avaliar riscos sobre PostgreSQL (US-033)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: { contractingType: string; origin: string; market: string; marketB: string };

  const tenantOf = (subject: string): string => (subject === SUBJECTS.beto ? B : A);
  const call = (test: request.Test, subject: string = SUBJECTS.ana) =>
    test
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));

  /** Processo pelo PRC-02 (Ana responsável), em andamento na etapa "ETP e mapa de riscos". */
  const createProcess = async (): Promise<ProcessDto> => {
    const response = await call(request(api.server).post('/api/v1/processes'))
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Compra ${words(2)}`,
        object: `Objeto ${words(3)}`,
        contractingTypeId: catalog.contractingType,
        requestingSecretariatId: OBRAS,
        requestingDepartmentId: MANUTENCAO,
        originId: catalog.origin,
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const process = (response.body as { data: ProcessDto }).data;
    await db.admin(
      `UPDATE processes p SET status = 'IN_PROGRESS', current_workflow_stage_id = ws.id
         FROM workflow_stages ws
        WHERE p.id = $1 AND ws.workflow_version_id = p.workflow_version_id
          AND ws.key = 'ESTUDOS_PRELIMINARES'`,
      [process.id],
    );
    return process;
  };
  const create = (
    processId: string,
    body: Record<string, unknown> = {},
    subject: string = SUBJECTS.ana,
  ) =>
    call(request(api.server).post(`/api/v1/processes/${processId}/risks`), subject)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Risco ${words(1)}`,
        categoryId: catalog.market,
        phase: 'PLANNING',
        cause: 'Mercado local com poucos fornecedores habilitados',
        consequence: 'Licitação deserta e atraso na contratação',
        probability: 4,
        impact: 4,
        ...body,
      });
  const patch = (
    riskId: string,
    body: Record<string, unknown>,
    ifMatch: string,
    subject?: string,
  ) =>
    call(request(api.server).patch(`/api/v1/risks/${riskId}`), subject)
      .set('If-Match', ifMatch)
      .send(body);
  const catalogId = async (tenantId: string, type: string, code: string) => {
    const [row] = await db.admin<{ id: string }>(
      'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
      [tenantId, type, code],
    );
    if (!row) throw new Error(`${type}/${code} ausente`);
    return row.id;
  };
  /** Tudo que os riscos gravam do processo (para provar o rollback). */
  const effects = async (processId: string) => ({
    risks: await db.admin<Row>(
      `SELECT id, code, score, level::text, scale_snapshot, deleted_at IS NOT NULL AS deleted, version
         FROM risks WHERE process_id = $1 ORDER BY code`,
      [processId],
    ),
    timeline: await db.admin<Row>(
      "SELECT type::text, params FROM process_timeline_entries WHERE process_id = $1 AND type::text LIKE 'RISK_%' ORDER BY occurred_at, id",
      [processId],
    ),
    audit: await db.admin<Row>(
      "SELECT action, metadata FROM audit_logs WHERE process_id = $1 AND action LIKE 'risk.%' ORDER BY occurred_at, id",
      [processId],
    ),
    events: await db.admin<Row>(
      "SELECT event_type, payload, status::text FROM outbox_events WHERE process_id = $1 AND event_type LIKE 'Risk%' ORDER BY occurred_at, id",
      [processId],
    ),
  });

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
      DATABASE_POOL_SIZE: '10',
    });
    api = await createTestApi({
      config,
      providers: [
        { token: MEMBERSHIP_PORT, value: membership },
        { token: PROCESS_CLOCK, value: () => NOW },
        { token: CATALOG_CLOCK, value: () => NOW },
        { token: RISK_CLOCK, value: () => NOW },
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
    catalog = {
      contractingType: await catalogId(A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      origin: await catalogId(A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
      market: await catalogId(A, 'RISK_CATEGORY', 'MERCADO_FORNECEDOR'),
      marketB: await catalogId(B, 'RISK_CATEGORY', 'MERCADO_FORNECEDOR'),
    };
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] criar, reavaliar e excluir com tratamentos: snapshot, cascata, código não reaproveitado, timeline, auditoria e eventos PENDING', async () => {
    const process = await createProcess();
    const created = await create(process.id);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const first = (created.body as { data: RiskDto }).data;
    expect(first).toMatchObject({ code: 'R01', score: 16, level: 'HIGH' });

    const reassessed = await patch(first.id, { probability: 2 }, '"1"');
    expect(reassessed.status, JSON.stringify(reassessed.body)).toBe(200);
    expect((reassessed.body as { data: RiskDto }).data).toMatchObject({
      score: 8,
      level: 'MEDIUM',
      version: 2,
    });

    await db.admin(
      `INSERT INTO risk_treatments (id, tenant_id, risk_id, process_id, type, description)
       VALUES ($1, $2, $3, $4, 'PREVENTIVE', 'Ampliar a divulgação'),
              ($5, $2, $3, $4, 'CONTINGENCY', 'Contratação emergencial')`,
      [randomUUID(), A, first.id, process.id, randomUUID()],
    );
    const removed = await call(request(api.server).delete(`/api/v1/risks/${first.id}`)).set(
      'If-Match',
      '"2"',
    );
    expect(removed.status, JSON.stringify(removed.body)).toBe(204);
    const treatments = await db.admin<Row>(
      'SELECT deleted_at IS NOT NULL AS deleted FROM risk_treatments WHERE risk_id = $1',
      [first.id],
    );
    expect(treatments).toEqual([{ deleted: true }, { deleted: true }]);

    const second = await create(process.id);
    expect((second.body as { data: RiskDto }).data.code).toBe('R02');

    const after = await effects(process.id);
    expect(after.risks.map((row) => [row.code, row.deleted, row.version])).toEqual([
      ['R01', true, 3],
      ['R02', false, 1],
    ]);
    expect(after.risks[0]?.scale_snapshot).toMatchObject({
      scale: { max: 5 },
      levelThresholds: [
        { level: 'LOW', minScore: 1, maxScore: 4 },
        { level: 'MEDIUM', minScore: 5, maxScore: 9 },
        { level: 'HIGH', minScore: 10, maxScore: 16 },
        { level: 'EXTREME', minScore: 17, maxScore: 25 },
      ],
    });
    expect(after.timeline.map((row) => row.type)).toEqual([
      'RISK_ADDED',
      'RISK_LEVEL_CHANGED',
      'RISK_REMOVED',
      'RISK_ADDED',
    ]);
    expect(after.audit.map((row) => row.action)).toEqual([
      'risk.create',
      'risk.assess',
      'risk.delete',
      'risk.create',
    ]);
    expect(after.audit[2]?.metadata).toMatchObject({ code: 'R01', treatmentsRemoved: 2 });
    // [Falha de integração] relay fora: os eventos ficam PENDING, só com ids, código e níveis.
    expect(after.events.map((row) => [row.event_type, row.status])).toEqual([
      ['RiskCreated', 'PENDING'],
      ['RiskAssessed', 'PENDING'],
      ['RiskDeleted', 'PENDING'],
      ['RiskCreated', 'PENDING'],
    ]);
    expect(after.events[1]?.payload).toEqual({
      riskId: first.id,
      fromLevel: 'HIGH',
      toLevel: 'MEDIUM',
      score: 8,
    });
  });

  it('[Concorrência] 10 criações paralelas de duas pessoas com custódia pela fila da unidade: R01..R10 sem repetição', async () => {
    const process = await createProcess();
    // Sem responsável: a custódia é da unidade atual (Ana e Carla lotadas em Manutenção — POL-01).
    await db.admin('UPDATE processes SET current_responsible_id = NULL WHERE id = $1', [
      process.id,
    ]);
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        create(process.id, {}, index % 2 === 0 ? SUBJECTS.ana : SUBJECTS.carla),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual(Array(10).fill(201));
    expect((await effects(process.id)).risks.map((row) => row.code)).toEqual(
      Array.from({ length: 10 }, (_, index) => `R${String(index + 1).padStart(2, '0')}`),
    );
  });

  it('[Concorrência] edição com If-Match desatualizado: 412 VERSION_CONFLICT com currentVersion, sem alterar', async () => {
    const process = await createProcess();
    const risk = ((await create(process.id)).body as { data: RiskDto }).data;
    // Sem responsável: Ana e Carla têm custódia pela fila de Manutenção (POL-02 vem antes do If-Match).
    await db.admin('UPDATE processes SET current_responsible_id = NULL WHERE id = $1', [
      process.id,
    ]);
    expect((await patch(risk.id, { impact: 3 }, '"1"')).status).toBe(200);
    const stale = await patch(risk.id, { impact: 1 }, '"1"', SUBJECTS.carla);
    expect(stale.status).toBe(412);
    expect(problemDetailsSchema.parse(stale.body).code).toBe('VERSION_CONFLICT');
    expect(stale.body).toMatchObject({ currentVersion: 2 });
    expect((await effects(process.id)).risks).toMatchObject([{ score: 12, version: 2 }]);
  });

  it('[Falha de banco] falha induzida DEPOIS de gravar o risco desfaz risco, timeline, auditoria e evento', async () => {
    const process = await createProcess();
    await db.admin(`
      CREATE FUNCTION test_fail_risk_timeline() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.type::text = 'RISK_ADDED' THEN
          RAISE EXCEPTION 'falha induzida no teste';
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_fail_risk_timeline BEFORE INSERT ON process_timeline_entries
        FOR EACH ROW EXECUTE FUNCTION test_fail_risk_timeline();`);
    try {
      const failed = await create(process.id);
      expect(failed.status).toBe(500);
      expect(await effects(process.id)).toEqual({ risks: [], timeline: [], audit: [], events: [] });
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_risk_timeline ON process_timeline_entries; DROP FUNCTION test_fail_risk_timeline();',
      );
    }
  });

  it('[Tenant incorreto] risco de A pelo tenant B: 404 sem alterar; categoria de B: 422; RLS, FK composta e checks do banco', async () => {
    const process = await createProcess();
    const risk = ((await create(process.id)).body as { data: RiskDto }).data;
    const before = await effects(process.id);

    const asBeto = (test: request.Test) => call(test, SUBJECTS.beto);
    for (const response of [
      await asBeto(request(api.server).get(`/api/v1/risks/${risk.id}`)),
      await asBeto(request(api.server).patch(`/api/v1/risks/${risk.id}`))
        .set('If-Match', '"1"')
        .send({ title: 'Alterado por B' }),
      await asBeto(request(api.server).delete(`/api/v1/risks/${risk.id}`)).set('If-Match', '"1"'),
      await asBeto(request(api.server).get(`/api/v1/processes/${process.id}/risks`)),
    ]) {
      expect(response.status).toBe(404);
      expect(problemDetailsSchema.parse(response.body).code).toBe('NOT_FOUND');
    }
    expect(await effects(process.id)).toEqual(before);

    const foreign = await create(process.id, { categoryId: catalog.marketB });
    expect(foreign.status).toBe(422);
    expect(
      problemDetailsSchema.parse(foreign.body).errors.map((error) => [error.field, error.code]),
    ).toEqual([['categoryId', 'REFERENCE_NOT_FOUND']]);

    // RLS: com `app.tenant_id` de B, nenhum risco de A é visível nem alterável.
    const client = db.client('cf_app');
    try {
      const visible = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$queryRaw<{ count: number }[]>`
            SELECT count(*)::int AS count FROM risks WHERE id = ${risk.id}::uuid`,
        ),
      );
      expect(visible).toEqual([{ count: 0 }]);
      const updated = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$executeRaw`
            UPDATE risks SET title = 'LEAK-B' WHERE id = ${risk.id}::uuid`,
        ),
      );
      expect(updated).toBe(0);
    } finally {
      await client.$disconnect();
    }

    const insert = (categoryId: string, score: number) =>
      db.admin(
        `INSERT INTO risks (id, tenant_id, process_id, code, title, category_id, phase, cause,
                            consequence, probability, impact, score, level, scale_snapshot)
         VALUES ($1, $2, $3, 'R90', 'Risco direto', $4, 'PLANNING', 'Causa com tamanho',
                 'Consequência longa', 2, 3, $5, 'MEDIUM', '{}'::jsonb)`,
        [randomUUID(), A, process.id, categoryId, score],
      );
    // FK composta: risco de A com categoria de B é recusado pelo banco.
    await expect(insert(catalog.marketB, 6)).rejects.toThrow();
    // CHECK `score = probability * impact`.
    await expect(insert(catalog.market, 7)).rejects.toThrow();
    // Código imutável (gatilho).
    await expect(
      db.admin("UPDATE risks SET code = 'R99' WHERE id = $1", [risk.id]),
    ).rejects.toThrow();
  });
});
