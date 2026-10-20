// Itens e condições contratuais do TR sobre PostgreSQL real (US-038 · Sucesso, Tenant incorreto,
// Concorrência, Falha de banco): a API inteira como `cf_app` (RLS) com os seeders reais, o processo
// pelo PRC-02 (Ana) com os itens "Cimento CP-II" e "Areia média", levado à etapa TERMO_REFERENCIA, e
// o TR pelo TRM-02 (Carla). Prova o DOC-07 gravando especificação e critérios de aceitação (`jsonb`)
// com a auditoria em hash + tamanho e sem versão nova do documento, o TRM-04 gravando as condições
// em `terms_of_reference` (garantia `numeric(9,4)`), a unicidade `(tenant, documento, item)` e os
// CHECKs do cabeçalho, o item e o critério da Prefeitura B recusados como inexistentes (RLS — 422
// `REFERENCE_NOT_FOUND`), o TR de A invisível ao tenant B, 5 PATCHes paralelos com o mesmo
// `If-Match` (exatamente um 200) e a falha induzida no meio da substituição dos itens desfazendo
// tudo. `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { ProcessDto, ProcessItemDto, TermDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
import { PROCESS_CLOCK } from '../../src/modules/process/application/ports.js';
import { TERM_CLOCK } from '../../src/modules/term/application/ports.js';
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

const A = '0192c038-0000-7000-8000-00000000010a';
const B = '0192c038-0000-7000-8000-00000000010b';
const ORG_A = '0192c038-0000-7000-8000-0000000010a0';
const ORG_B = '0192c038-0000-7000-8000-0000000010b0';
const OBRAS = '0192c038-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c038-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c038-0000-7000-8000-0000000010b1';
const ANA = '0192c038-0000-7000-8000-0000000010c1';
const CARLA = '0192c038-0000-7000-8000-0000000010c2';
const BETO = '0192c038-0000-7000-8000-0000000010c3';
const ANA_M = '0192c038-0000-7000-8000-0000000010d1';
const PROCESS_B = '0192c038-0000-7000-8000-0000000010f1';
const ITEM_B = '0192c038-0000-7000-8000-0000000010f2';
const NOW = new Date('2026-10-20T15:00:00.000Z');
const MFA = ['pwd', 'otp'];
const SPEC = 'Cimento Portland CP-II-E-32 em sacos de 50 kg';

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [CARLA]: ['PLANEJAMENTO'],
  [BETO]: ['PLANEJAMENTO'],
};

const SUBJECTS = {
  ana: 'sub-ana-us038',
  carla: 'sub-carla-us038',
  beto: 'sub-beto-us038',
} as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us038', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'santa-luzia-us038', 'Prefeitura de Santa Luzia LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura de Santa Luzia LEAK-B', 'PMSL', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Obras LEAK-B', '${path(OBRAS_B)}', 0);
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', '${SUBJECTS.ana}', 'ana-us038@a.test', true, 'Ana Souza'),
  ('${CARLA}', '${SUBJECTS.carla}', 'carla-us038@a.test', true, 'Carla Lima'),
  ('${BETO}', '${SUBJECTS.beto}', 'beto-us038@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c038-0000-7000-8000-0000000010d2', '${A}', '${CARLA}', 'INTERNAL', 'ACTIVE'),
  ('0192c038-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c038-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
`;

/** Processo e item da Prefeitura B (SQL com as FKs desligadas — só o id importa). */
const TENANT_B_ITEM_SQL = (unitId: string) => `
SET session_replication_role = replica;
INSERT INTO processes (id, tenant_id, organization_id, year, title, object, contracting_type_id,
  requesting_secretariat_id, requesting_department_id, current_department_id, workflow_version_id,
  origin_id, pca_status, created_by_id)
VALUES ('${PROCESS_B}', '${B}', '${ORG_B}', 2026, 'Processo LEAK-B', 'Objeto do processo LEAK-B',
  '${OBRAS_B}', '${OBRAS_B}', '${OBRAS_B}', '${OBRAS_B}', '${OBRAS_B}', '${OBRAS_B}',
  'NOT_APPLICABLE', '${BETO}');
INSERT INTO process_items (id, tenant_id, process_id, sequence, kind, description, unit_of_measure_id)
VALUES ('${ITEM_B}', '${B}', '${PROCESS_B}', 1, 'GOOD', 'Item secreto LEAK-B', '${unitId}');
SET session_replication_role = origin;
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

const paragraph = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe('Feature: Especificar itens e condições contratuais do TR sobre PostgreSQL (US-038)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: { contractingType: string; origin: string; un: string; menorPreco: string };
  let criterionB: string;

  const tenantOf = (subject: string): string => (subject === SUBJECTS.beto ? B : A);
  const call = (test: request.Test, subject: string = SUBJECTS.carla) =>
    test
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));

  /** Background: processo (PRC-02, Ana) com dois itens, na etapa do TR, e o TR (TRM-02, Carla). */
  const background = async () => {
    const response = await call(request(api.server).post('/api/v1/processes'), SUBJECTS.ana)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Reforma da escola ${words(2)}`,
        object: `Aquisição de materiais de construção para a reforma ${words(2)}`,
        contractingTypeId: catalog.contractingType,
        requestingSecretariatId: OBRAS,
        requestingDepartmentId: MANUTENCAO,
        originId: catalog.origin,
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const process = (response.body as { data: ProcessDto }).data;
    const items: ProcessItemDto[] = [];
    for (const description of ['Cimento CP-II', 'Areia média']) {
      const item = await call(
        request(api.server).post(`/api/v1/processes/${process.id}/items`),
        SUBJECTS.ana,
      )
        .set('Idempotency-Key', randomUUID())
        .send({ kind: 'GOOD', description, unitOfMeasureId: catalog.un });
      expect(item.status, JSON.stringify(item.body)).toBe(201);
      items.push((item.body as { data: ProcessItemDto }).data);
    }
    await db.admin(
      `UPDATE processes p SET status = 'IN_PROGRESS', current_workflow_stage_id = ws.id,
              current_responsible_id = $2
         FROM workflow_stages ws
        WHERE p.id = $1 AND ws.workflow_version_id = p.workflow_version_id
          AND ws.key = 'TERMO_REFERENCIA'`,
      [process.id, CARLA],
    );
    const created = await call(request(api.server).post(`/api/v1/processes/${process.id}/terms`))
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return { process, items, term: (created.body as { data: TermDto }).data };
  };

  const documentVersion = async (documentId: string) => {
    const [row] = await db.admin<{ version: number }>(
      'SELECT version FROM documents WHERE id = $1',
      [documentId],
    );
    return row?.version ?? 0;
  };
  const putItems = async (
    documentId: string,
    items: readonly Record<string, unknown>[],
    subject: string = SUBJECTS.carla,
  ) =>
    call(request(api.server).put(`/api/v1/documents/${documentId}/items`), subject)
      .set('If-Match', `"${String(await documentVersion(documentId))}"`)
      .send({ items });
  const patchTerm = (
    termId: string,
    body: Record<string, unknown>,
    ifMatch: number,
    subject: string = SUBJECTS.carla,
  ) =>
    call(request(api.server).patch(`/api/v1/terms/${termId}`), subject)
      .set('If-Match', `"${String(ifMatch)}"`)
      .send(body);
  const itemRows = (documentId: string) =>
    db.admin<Row>(
      `SELECT process_item_id, quantity::text AS quantity, specification, acceptance_criteria
         FROM document_items WHERE document_id = $1 ORDER BY sort_order, created_at`,
      [documentId],
    );
  const termRow = async (termId: string) => {
    const [row] = await db.admin<Row>(
      `SELECT contract_duration_months, execution_deadline, execution_deadline_type::text AS deadline_type,
              payment_term_days, contract_guarantee_percent::text AS guarantee,
              selection_criterion_id, award_type::text AS award_type, version
         FROM terms_of_reference WHERE id = $1`,
      [termId],
    );
    return row;
  };
  const auditsOf = (entityId: string, action: string) =>
    db.admin<{ changes: unknown; metadata: Row }>(
      `SELECT changes, metadata FROM audit_logs WHERE entity_id = $1 AND action = $2
        ORDER BY occurred_at, id`,
      [entityId, action],
    );
  const catalogId = async (tenantId: string, type: string, code: string) => {
    const [row] = await db.admin<{ id: string }>(
      'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
      [tenantId, type, code],
    );
    if (!row) throw new Error(`${type}/${code} ausente`);
    return row.id;
  };

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
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
        { token: TERM_CLOCK, value: () => NOW },
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
    const seeders = [
      'catalog.items',
      'access.defaultRoles',
      'document.systemTypes',
      'document.templateLibrary',
      'workflow.seedWorkflows',
    ];
    await runTenantSeeders(api, A, seeders);
    await runTenantSeeders(api, B, seeders);
    catalog = {
      contractingType: await catalogId(A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      origin: await catalogId(A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
      un: await catalogId(A, 'UNIT_OF_MEASURE', 'UN'),
      menorPreco: await catalogId(A, 'JUDGMENT_CRITERION', 'MENOR_PRECO'),
    };
    criterionB = await catalogId(B, 'JUDGMENT_CRITERION', 'MENOR_PRECO');
    await db.admin(TENANT_B_ITEM_SQL(await catalogId(B, 'UNIT_OF_MEASURE', 'UN')));
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] DOC-07 grava especificação/critérios (jsonb) com auditoria em hash; TRM-04 grava as condições em terms_of_reference', async () => {
    const { items, term } = await background();
    const [cement, sand] = items;
    const saved = await putItems(term.documentId, [
      {
        processItemId: cement?.id,
        quantity: '100',
        specification: paragraph(SPEC),
        acceptanceCriteria: paragraph('Laudo NBR 16697'),
        sortOrder: 0,
      },
      { processItemId: sand?.id, quantity: '50', sortOrder: 1 },
    ]);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(await itemRows(term.documentId)).toEqual([
      {
        process_item_id: cement?.id,
        quantity: '100.0000',
        specification: paragraph(SPEC),
        acceptance_criteria: paragraph('Laudo NBR 16697'),
      },
      {
        process_item_id: sand?.id,
        quantity: '50.0000',
        specification: null,
        acceptance_criteria: null,
      },
    ]);
    const audits = await auditsOf(term.documentId, 'document.items_update');
    expect(JSON.stringify(audits.at(-1)?.changes)).toContain('specification');
    expect(JSON.stringify(audits)).not.toContain('Portland');
    const [document] = await db.admin<Row>(
      'SELECT current_version_id FROM documents WHERE id = $1',
      [term.documentId],
    );
    expect(document).toEqual({ current_version_id: null });

    const patched = await patchTerm(
      term.id,
      {
        contractDurationMonths: 12,
        executionDeadline: 30,
        executionDeadlineType: 'CALENDAR',
        paymentTermDays: 30,
        contractGuaranteePercent: '5',
        selectionCriterionId: catalog.menorPreco,
        awardType: 'BY_ITEM',
      },
      term.version,
    );
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect((patched.body as { data: TermDto }).data.contractGuaranteePercent).toBe('5');
    expect(await termRow(term.id)).toEqual({
      contract_duration_months: 12,
      execution_deadline: 30,
      deadline_type: 'CALENDAR',
      payment_term_days: 30,
      guarantee: '5.0000',
      selection_criterion_id: catalog.menorPreco,
      award_type: 'BY_ITEM',
      version: term.version + 1,
    });
    // O mesmo valor de novo não grava (comparação com o `numeric` lido do banco).
    const same = await patchTerm(term.id, { contractGuaranteePercent: '5.0' }, term.version + 1);
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    expect(await termRow(term.id)).toMatchObject({ version: term.version + 1 });
    expect(await auditsOf(term.documentId, 'document.draft_update')).toHaveLength(1);
  });

  it('[Validação] unicidade (tenant, documento, item) e CHECKs de garantia e prazo no banco', async () => {
    const { items, term } = await background();
    const [cement] = items;
    expect(
      (await putItems(term.documentId, [{ processItemId: cement?.id, quantity: '1' }])).status,
    ).toBe(200);
    await expect(
      db.admin(
        `INSERT INTO document_items (id, tenant_id, document_id, process_item_id, quantity)
         VALUES ($1, $2, $3, $4, 2)`,
        [randomUUID(), A, term.documentId, cement?.id],
      ),
    ).rejects.toThrow(/document_items_document_process_item_key/);
    await expect(
      db.admin('UPDATE terms_of_reference SET contract_guarantee_percent = 15 WHERE id = $1', [
        term.id,
      ]),
    ).rejects.toThrow(/check/i);
    await expect(
      db.admin(
        'UPDATE terms_of_reference SET execution_deadline = 30, execution_deadline_type = NULL WHERE id = $1',
        [term.id],
      ),
    ).rejects.toThrow(/check/i);
  });

  it('[Tenant incorreto] item e critério da Prefeitura B → 422 REFERENCE_NOT_FOUND sem revelar; TR de A visto de B → 404; a RLS de B não vê os itens', async () => {
    const { items, term } = await background();
    const foreignItem = await putItems(term.documentId, [{ processItemId: ITEM_B, quantity: '1' }]);
    expect(foreignItem.status, JSON.stringify(foreignItem.body)).toBe(422);
    expect(problemDetailsSchema.parse(foreignItem.body).errors).toEqual([
      expect.objectContaining({ field: 'items[0].processItemId', code: 'REFERENCE_NOT_FOUND' }),
    ]);
    expect(JSON.stringify(foreignItem.body)).not.toContain('LEAK-B');

    const foreignCriterion = await patchTerm(
      term.id,
      { selectionCriterionId: criterionB },
      term.version,
    );
    expect(foreignCriterion.status, JSON.stringify(foreignCriterion.body)).toBe(422);
    expect(problemDetailsSchema.parse(foreignCriterion.body).errors).toEqual([
      expect.objectContaining({ field: 'selectionCriterionId', code: 'REFERENCE_NOT_FOUND' }),
    ]);

    const fromB = await patchTerm(
      term.id,
      { contractDurationMonths: 6 },
      term.version,
      SUBJECTS.beto,
    );
    expect(fromB.status, JSON.stringify(fromB.body)).toBe(404);
    expect(await termRow(term.id)).toMatchObject({
      contract_duration_months: null,
      version: term.version,
    });

    expect(
      (await putItems(term.documentId, [{ processItemId: items[0]?.id, quantity: '3' }])).status,
    ).toBe(200);
    const client = db.client('cf_app');
    try {
      const visible = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$queryRaw<{ count: number }[]>`
            SELECT (SELECT count(*)::int FROM terms_of_reference WHERE id = ${term.id}::uuid)
                 + (SELECT count(*)::int FROM document_items WHERE document_id = ${term.documentId}::uuid)
              AS count`,
        ),
      );
      expect(visible).toEqual([{ count: 0 }]);
    } finally {
      await client.$disconnect();
    }
  });

  it('[Concorrência] 5 PATCHes simultâneos das condições com o mesmo If-Match: exatamente um 200, os demais 412', async () => {
    const { term } = await background();
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        patchTerm(term.id, { contractDurationMonths: 10 + index }, term.version),
      ),
    );
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 412)).toHaveLength(4);
    for (const response of responses.filter((candidate) => candidate.status === 412)) {
      expect(problemDetailsSchema.parse(response.body).code).toBe('VERSION_CONFLICT');
    }
    expect(await termRow(term.id)).toMatchObject({ version: term.version + 1 });
  });

  it('[Falha de banco] falha induzida no meio da substituição dos itens desfaz tudo', async () => {
    const { items, term } = await background();
    const [cement, sand] = items;
    expect(
      (await putItems(term.documentId, [{ processItemId: cement?.id, quantity: '1' }])).status,
    ).toBe(200);
    const before = await itemRows(term.documentId);
    const version = await documentVersion(term.documentId);
    await db.admin(`
      CREATE FUNCTION test_fail_document_items_insert() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        RAISE EXCEPTION 'falha induzida no teste';
      END $fn$;
      CREATE TRIGGER test_fail_document_items_insert BEFORE INSERT ON document_items
        FOR EACH ROW EXECUTE FUNCTION test_fail_document_items_insert();`);
    try {
      const failed = await putItems(term.documentId, [
        { processItemId: cement?.id, quantity: '9', specification: paragraph(SPEC) },
        { processItemId: sand?.id, quantity: '5' },
      ]);
      expect(failed.status, JSON.stringify(failed.body)).toBeGreaterThanOrEqual(500);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_document_items_insert ON document_items; DROP FUNCTION test_fail_document_items_insert();',
      );
    }
    expect(await itemRows(term.documentId)).toEqual(before);
    expect(await documentVersion(term.documentId)).toBe(version);
  });
});
