// Ações de tratamento sobre PostgreSQL real (US-034 · Sucesso, Tenant incorreto, Concorrência,
// Falha de banco, Falha de integração): a API inteira como `cf_app` (RLS) com os seeders reais, o
// processo criado pelo PRC-02 na etapa "ETP e mapa de riscos" e o risco R01 pelo RSK-02. Prova a
// transição automática do risco para IN_TREATMENT na mesma transação do tratamento (RN-RISK-14), o
// `completed_at` do DONE (RN-RISK-12 + CHECK do banco), cancelar/excluir sem reverter o risco
// (FA-04), a exclusão lógica (RN-RISK-17), a transação única por falha induzida DEPOIS de gravar o
// tratamento (nada persiste: tratamento, status do risco, auditoria e outbox), os eventos `PENDING`,
// o 412 e a RLS (tratamento e responsável de outro tenant).
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { ProcessDto, RiskDto, RiskTreatmentDto } from '@contrataflow/validation';
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

const A = '0192c034-0000-7000-8000-00000000010a';
const B = '0192c034-0000-7000-8000-00000000010b';
const ORG_A = '0192c034-0000-7000-8000-0000000010a0';
const ORG_B = '0192c034-0000-7000-8000-0000000010b0';
const OBRAS = '0192c034-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c034-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c034-0000-7000-8000-0000000010b1';
const ANA = '0192c034-0000-7000-8000-0000000010c1';
const CARLA = '0192c034-0000-7000-8000-0000000010c2';
const BETO = '0192c034-0000-7000-8000-0000000010c3';
const ANA_M = '0192c034-0000-7000-8000-0000000010d1';
const CARLA_M = '0192c034-0000-7000-8000-0000000010d2';
const NOW = new Date('2026-10-18T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [CARLA]: ['REQUISITANTE'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const SUBJECTS = {
  ana: 'sub-ana-us034',
  carla: 'sub-carla-us034',
  beto: 'sub-beto-us034',
} as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us034', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us034', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
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
  ('0192c034-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c034-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true),
  ('0192c034-0000-7000-8000-0000000010e2', '${A}', '${CARLA_M}', '${MANUTENCAO}', true);
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

describe('Feature: Gerenciar ações de tratamento sobre PostgreSQL (US-034)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: { contractingType: string; origin: string; market: string };

  const tenantOf = (subject: string): string => (subject === SUBJECTS.beto ? B : A);
  const call = (test: request.Test, subject: string = SUBJECTS.ana) =>
    test
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));

  /** Processo pelo PRC-02 (Ana responsável) em andamento na etapa do mapa de riscos, com R01. */
  const createRisk = async (): Promise<{ process: ProcessDto; risk: RiskDto }> => {
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
    const risk = await call(request(api.server).post(`/api/v1/processes/${process.id}/risks`))
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Risco ${words(1)}`,
        categoryId: catalog.market,
        phase: 'PLANNING',
        cause: 'Mercado local com poucos fornecedores habilitados',
        consequence: 'Licitação deserta e atraso na contratação',
        probability: 4,
        impact: 4,
      });
    expect(risk.status, JSON.stringify(risk.body)).toBe(201);
    return { process, risk: (risk.body as { data: RiskDto }).data };
  };
  const create = (riskId: string, body: Record<string, unknown> = {}, subject?: string) =>
    call(request(api.server).post(`/api/v1/risks/${riskId}/treatments`), subject)
      .set('Idempotency-Key', randomUUID())
      .send({
        type: 'PREVENTIVE',
        description: 'Ampliar a divulgação do edital em jornais regionais',
        responsibleId: ANA,
        dueDate: '2026-11-30',
        ...body,
      });
  const patch = (
    treatmentId: string,
    body: Record<string, unknown>,
    ifMatch: string,
    subject?: string,
  ) =>
    call(request(api.server).patch(`/api/v1/risk-treatments/${treatmentId}`), subject)
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
  /** Tudo que os tratamentos gravam do processo (para provar o rollback). */
  const effects = async (processId: string) => ({
    risks: await db.admin<Row>(
      'SELECT status::text, version FROM risks WHERE process_id = $1 ORDER BY code',
      [processId],
    ),
    treatments: await db.admin<Row>(
      `SELECT status::text, due_date::text, completed_at, sort_order,
              deleted_at IS NOT NULL AS deleted, version
         FROM risk_treatments WHERE process_id = $1 ORDER BY created_at, id`,
      [processId],
    ),
    audit: await db.admin<Row>(
      "SELECT action, metadata FROM audit_logs WHERE process_id = $1 AND action LIKE 'risk.treatment_%' ORDER BY occurred_at, id",
      [processId],
    ),
    events: await db.admin<Row>(
      "SELECT payload, status::text FROM outbox_events WHERE process_id = $1 AND event_type = 'RiskTreatmentChanged' ORDER BY occurred_at, id",
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
    };
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] criar (risco IN_TREATMENT), concluir (completed_at), cancelar e excluir sem reverter o risco; eventos PENDING', async () => {
    const { process, risk } = await createRisk();
    const created = await create(risk.id);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const first = (created.body as { data: RiskTreatmentDto }).data;
    expect(first).toMatchObject({ status: 'PLANNED', dueDate: '2026-11-30', sortOrder: 0 });
    expect((await effects(process.id)).risks).toEqual([{ status: 'IN_TREATMENT', version: 2 }]);

    expect((await patch(first.id, { status: 'IN_PROGRESS' }, '"1"')).status).toBe(200);
    const done = await patch(first.id, { status: 'DONE' }, '"2"');
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((done.body as { data: RiskTreatmentDto }).data.completedAt).toBe(NOW.toISOString());

    const second = (
      (await create(risk.id, { type: 'CONTINGENCY', dueDate: null })).body as {
        data: RiskTreatmentDto;
      }
    ).data;
    expect((await patch(second.id, { status: 'CANCELED' }, '"1"')).status).toBe(200);
    const removed = await call(
      request(api.server).delete(`/api/v1/risk-treatments/${second.id}`),
    ).set('If-Match', '"2"');
    expect(removed.status, JSON.stringify(removed.body)).toBe(204);

    const after = await effects(process.id);
    expect(after.risks).toEqual([{ status: 'IN_TREATMENT', version: 2 }]);
    expect(after.treatments).toEqual([
      {
        status: 'DONE',
        due_date: '2026-11-30',
        completed_at: NOW,
        sort_order: 0,
        deleted: false,
        version: 3,
      },
      {
        status: 'CANCELED',
        due_date: null,
        completed_at: null,
        sort_order: 1,
        deleted: true,
        version: 3,
      },
    ]);
    expect(after.audit.map((row) => row.action)).toEqual([
      'risk.treatment_create',
      'risk.treatment_update',
      'risk.treatment_update',
      'risk.treatment_create',
      'risk.treatment_update',
      'risk.treatment_delete',
    ]);
    // [Falha de integração] relay fora: os eventos ficam PENDING, só com ids e status.
    expect(after.events.map((row) => [(row.payload as Row).change, row.status])).toEqual([
      ['CREATED', 'PENDING'],
      ['STATUS_CHANGED', 'PENDING'],
      ['STATUS_CHANGED', 'PENDING'],
      ['CREATED', 'PENDING'],
      ['STATUS_CHANGED', 'PENDING'],
      ['DELETED', 'PENDING'],
    ]);
    expect(after.events[0]?.payload).toEqual({
      riskId: risk.id,
      treatmentId: first.id,
      change: 'CREATED',
      status: 'PLANNED',
    });

    // CHECK do banco (RN-RISK-12): DONE sem completed_at é recusado.
    await expect(
      db.admin("UPDATE risk_treatments SET completed_at = NULL WHERE id = $1 AND status = 'DONE'", [
        first.id,
      ]),
    ).rejects.toThrow();
  });

  it('[Concorrência] edição com If-Match desatualizado: 412 VERSION_CONFLICT com currentVersion, sem alterar', async () => {
    const { process, risk } = await createRisk();
    const treatment = ((await create(risk.id)).body as { data: RiskTreatmentDto }).data;
    expect((await patch(treatment.id, { notes: 'Ana primeiro' }, '"1"')).status).toBe(200);
    const stale = await patch(treatment.id, { notes: 'Carla depois' }, '"1"', SUBJECTS.carla);
    expect(stale.status).toBe(412);
    expect(problemDetailsSchema.parse(stale.body).code).toBe('VERSION_CONFLICT');
    expect(stale.body).toMatchObject({ currentVersion: 2 });
    expect((await effects(process.id)).treatments).toMatchObject([{ version: 2 }]);
  });

  it('[Falha de banco] falha induzida DEPOIS de gravar o tratamento desfaz tratamento, status do risco, auditoria e evento', async () => {
    const { process, risk } = await createRisk();
    const before = await effects(process.id);
    await db.admin(`
      CREATE FUNCTION test_fail_risk_treatment_outbox() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.event_type = 'RiskTreatmentChanged' THEN
          RAISE EXCEPTION 'falha induzida no teste';
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_fail_risk_treatment_outbox BEFORE INSERT ON outbox_events
        FOR EACH ROW EXECUTE FUNCTION test_fail_risk_treatment_outbox();`);
    try {
      const failed = await create(risk.id);
      expect(failed.status).toBe(500);
      expect(await effects(process.id)).toEqual(before);
      expect(before.risks).toEqual([{ status: 'OPEN', version: 1 }]);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_risk_treatment_outbox ON outbox_events; DROP FUNCTION test_fail_risk_treatment_outbox();',
      );
    }
  });

  it('[Tenant incorreto] tratamento de A pelo tenant B: 404 sem alterar; responsável de B: 422; RLS de risk_treatments', async () => {
    const { process, risk } = await createRisk();
    const treatment = ((await create(risk.id)).body as { data: RiskTreatmentDto }).data;
    const before = await effects(process.id);

    const asBeto = (test: request.Test) => call(test, SUBJECTS.beto);
    for (const response of [
      await asBeto(request(api.server).post(`/api/v1/risks/${risk.id}/treatments`))
        .set('Idempotency-Key', randomUUID())
        .send({ type: 'PREVENTIVE', description: 'Tratamento vindo de B LEAK-B' }),
      await asBeto(request(api.server).patch(`/api/v1/risk-treatments/${treatment.id}`))
        .set('If-Match', '"1"')
        .send({ notes: 'Alterado por B' }),
      await asBeto(request(api.server).delete(`/api/v1/risk-treatments/${treatment.id}`)).set(
        'If-Match',
        '"1"',
      ),
    ]) {
      expect(response.status).toBe(404);
      expect(problemDetailsSchema.parse(response.body).code).toBe('NOT_FOUND');
    }
    expect(await effects(process.id)).toEqual(before);

    const foreign = await create(risk.id, { responsibleId: BETO });
    expect(foreign.status).toBe(422);
    expect(
      problemDetailsSchema.parse(foreign.body).errors.map((error) => [error.field, error.code]),
    ).toEqual([['responsibleId', 'REFERENCE_NOT_FOUND']]);
    expect(JSON.stringify(foreign.body)).not.toContain('LEAK-B');
    const foreignUnit = await create(risk.id, { responsibleDepartmentId: OBRAS_B });
    expect(foreignUnit.status).toBe(422);

    // RLS: com `app.tenant_id` de B, nenhum tratamento de A é visível nem alterável.
    const client = db.client('cf_app');
    try {
      const visible = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$queryRaw<{ count: number }[]>`
            SELECT count(*)::int AS count FROM risk_treatments WHERE id = ${treatment.id}::uuid`,
        ),
      );
      expect(visible).toEqual([{ count: 0 }]);
      const updated = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$executeRaw`
            UPDATE risk_treatments SET notes = 'LEAK-B' WHERE id = ${treatment.id}::uuid`,
        ),
      );
      expect(updated).toBe(0);
    } finally {
      await client.$disconnect();
    }
    // FK composta: tratamento de B apontando para o risco de A é recusado pelo banco.
    await expect(
      db.admin(
        `INSERT INTO risk_treatments (id, tenant_id, risk_id, process_id, type, description)
         VALUES ($1, $2, $3, $4, 'PREVENTIVE', 'Tratamento cruzado')`,
        [randomUUID(), B, risk.id, process.id],
      ),
    ).rejects.toThrow();
  });
});
