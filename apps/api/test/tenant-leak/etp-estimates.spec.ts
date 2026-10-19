// Estimativas do ETP sobre PostgreSQL real (US-022 · Sucesso, Tenant incorreto, Concorrência,
// Falha de integração): a API inteira como `cf_app` (RLS) com os seeders reais, o processo pelo
// PRC-02 (Ana) com dois itens, a pesquisa de preços pelo PRS-02 (Rui) e o ETP pelo ETP-02. Prova o
// DOC-07 gravando quantidade (numeric 18,4) e memória de cálculo (`jsonb`) com a auditoria em hash +
// tamanho, o ETP-04 copiando o total da pesquisa para `etps` (versão + 1, `document.draft_update`),
// a pesquisa de outro tenant recusada como inexistente (RLS — 422 `REFERENCE_NOT_FOUND`), o ETP de A
// invisível ao tenant B, 5 PATCHes paralelos com o mesmo `If-Match` (exatamente um 200) e o
// recálculo (PRS-20) deixando `PriceResearchRecalculated` PENDING no outbox sem tocar o ETP — a
// sincronização é do worker (`apps/worker/test/tenant-leak/etp-estimate-sync.spec.ts`).
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { etpDetailSchema, problemDetailsSchema } from '@contrataflow/validation';
import type {
  EtpDto,
  PriceResearchDto,
  ProcessDto,
  ProcessItemDto,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
import { ETP_CLOCK } from '../../src/modules/etp/application/ports.js';
import { PROCESS_CLOCK } from '../../src/modules/process/application/ports.js';
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

const A = '0192c022-0000-7000-8000-00000000010a';
const B = '0192c022-0000-7000-8000-00000000010b';
const ORG_A = '0192c022-0000-7000-8000-0000000010a0';
const ORG_B = '0192c022-0000-7000-8000-0000000010b0';
const OBRAS = '0192c022-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c022-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c022-0000-7000-8000-0000000010b1';
const ANA = '0192c022-0000-7000-8000-0000000010c1';
const RUI = '0192c022-0000-7000-8000-0000000010c2';
const BETO = '0192c022-0000-7000-8000-0000000010c3';
const ANA_M = '0192c022-0000-7000-8000-0000000010d1';
const PROCESS_B = '0192c022-0000-7000-8000-0000000010f1';
const RESEARCH_B = '0192c022-0000-7000-8000-0000000010f2';
const NOW = new Date('2026-10-19T15:00:00.000Z');
const MFA = ['pwd', 'otp'];
const MEMO = 'Consumo médio mensal (50) × 10 meses de obra';

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [RUI]: ['PLANEJAMENTO'],
  [BETO]: ['PLANEJAMENTO'],
};

const SUBJECTS = { ana: 'sub-ana-us022', rui: 'sub-rui-us022', beto: 'sub-beto-us022' } as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us022', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'santa-luzia-us022', 'Prefeitura de Santa Luzia LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
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
  ('${ANA}', '${SUBJECTS.ana}', 'ana-us022@a.test', true, 'Ana Souza'),
  ('${RUI}', '${SUBJECTS.rui}', 'rui-us022@a.test', true, 'Rui Costa'),
  ('${BETO}', '${SUBJECTS.beto}', 'beto-us022@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c022-0000-7000-8000-0000000010d2', '${A}', '${RUI}', 'INTERNAL', 'ACTIVE'),
  ('0192c022-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c022-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
`;

/** Pesquisa de preços FINALIZED da Prefeitura B (SQL com as FKs desligadas — só o id importa). */
const TENANT_B_RESEARCH_SQL = (documentTypeId: string) => `
SET session_replication_role = replica;
INSERT INTO processes (id, tenant_id, organization_id, year, title, object, contracting_type_id,
  requesting_secretariat_id, requesting_department_id, current_department_id, workflow_version_id,
  origin_id, pca_status, created_by_id)
VALUES ('${PROCESS_B}', '${B}', '${ORG_B}', 2026, 'Processo LEAK-B', 'Objeto do processo LEAK-B',
  '${OBRAS_B}', '${OBRAS_B}', '${OBRAS_B}', '${OBRAS_B}', '${OBRAS_B}', '${OBRAS_B}',
  'NOT_APPLICABLE', '${BETO}');
INSERT INTO documents (id, tenant_id, process_id, document_type_id, code, title, status, created_by_id)
VALUES ('${RESEARCH_B}', '${B}', '${PROCESS_B}', '${documentTypeId}', 'PP 0009/2026',
  'Pesquisa LEAK-B', 'FINALIZED', '${BETO}');
INSERT INTO price_research (id, tenant_id, process_id, document_id, reference_date, default_method,
  cv_threshold_percent, min_quotations, direct_quote_max_age_days, similar_contract_max_age_days,
  outlier_lower_percent, outlier_upper_percent, unit_price_decimals, rounding_mode,
  total_estimated_value)
VALUES ('${RESEARCH_B}', '${B}', '${PROCESS_B}', '${RESEARCH_B}', '2026-10-01', 'AUTO_CV', 25, 3,
  180, 365, 70, 130, 2, 'HALF_UP', 777777.77);
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

describe('Feature: Estimar quantidades e vincular valor à pesquisa de preços sobre PostgreSQL (US-022)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: { contractingType: string; origin: string; un: string };

  const tenantOf = (subject: string): string => (subject === SUBJECTS.beto ? B : A);
  const call = (test: request.Test, subject: string = SUBJECTS.rui) =>
    test
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));

  const moveTo = (processId: string, stageKey: string) =>
    db.admin(
      `UPDATE processes p SET status = 'IN_PROGRESS', current_workflow_stage_id = ws.id,
              current_responsible_id = $2
         FROM workflow_stages ws
        WHERE p.id = $1 AND ws.workflow_version_id = p.workflow_version_id AND ws.key = $3`,
      [processId, RUI, stageKey],
    );

  /**
   * Background: processo (PRC-02, Ana) com os itens "Cimento CP-II" e "Areia média"; a pesquisa de
   * preços (PRS-02, Rui) com o total `research` (FINALIZED) ou em DRAFT; o ETP (ETP-02, Rui) nos
   * estudos preliminares com os dois itens (DOC-07).
   */
  const background = async (options: { finalized?: boolean } = {}) => {
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
    for (const description of ['Cimento CP-II (saco 50kg)', 'Areia média']) {
      const item = await call(
        request(api.server).post(`/api/v1/processes/${process.id}/items`),
        SUBJECTS.ana,
      )
        .set('Idempotency-Key', randomUUID())
        .send({ kind: 'GOOD', description, unitOfMeasureId: catalog.un });
      expect(item.status, JSON.stringify(item.body)).toBe(201);
      items.push((item.body as { data: ProcessItemDto }).data);
    }
    await db.admin('UPDATE process_items SET reference_quantity = 400 WHERE process_id = $1', [
      process.id,
    ]);
    await moveTo(process.id, 'PESQUISA_PRECOS');
    const created = await call(
      request(api.server).post(`/api/v1/processes/${process.id}/price-research`),
    )
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const researchId = (created.body as { data: PriceResearchDto }).data.id;
    await db.admin(`UPDATE price_research SET total_estimated_value = 125000.00 WHERE id = $1`, [
      researchId,
    ]);
    if (options.finalized !== false) {
      await db.admin(
        `UPDATE documents SET status = 'FINALIZED', finalized_at = now(), finalized_by_id = $2,
                version = version + 1
          WHERE id = $1`,
        [researchId, RUI],
      );
    }
    await moveTo(process.id, 'ESTUDOS_PRELIMINARES');
    const etpResponse = await call(request(api.server).post(`/api/v1/processes/${process.id}/etps`))
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(etpResponse.status, JSON.stringify(etpResponse.body)).toBe(201);
    const etp = (etpResponse.body as { data: EtpDto }).data;
    const seeded = await putItems(
      etp.documentId,
      items.map((item) => ({ processItemId: item.id, quantity: '400' })),
      etp.documentVersion,
    );
    expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);
    return { process, items, researchId, etp };
  };

  const putItems = (
    documentId: string,
    items: readonly Record<string, unknown>[],
    ifMatch: number,
    subject: string = SUBJECTS.rui,
  ) =>
    call(request(api.server).put(`/api/v1/documents/${documentId}/items`), subject)
      .set('If-Match', `"${String(ifMatch)}"`)
      .send({ items });
  const patchEtp = (
    etpId: string,
    body: Record<string, unknown>,
    ifMatch: number,
    subject: string = SUBJECTS.rui,
  ) =>
    call(request(api.server).patch(`/api/v1/etps/${etpId}`), subject)
      .set('If-Match', `"${String(ifMatch)}"`)
      .send(body);
  const etpRow = async (etpId: string) => {
    const [row] = await db.admin<Row>(
      `SELECT estimated_total_value::text AS value, estimated_value_source::text AS source,
              price_research_id, version
         FROM etps WHERE id = $1`,
      [etpId],
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
        { token: ETP_CLOCK, value: () => NOW },
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
    };
    const [typeB] = await db.admin<{ id: string }>(
      `SELECT id FROM document_types WHERE tenant_id = $1 AND code = 'PRICE_RESEARCH'`,
      [B],
    );
    await db.admin(TENANT_B_RESEARCH_SQL(typeB?.id ?? ''));
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] DOC-07 grava quantidade e memória (jsonb) com auditoria em hash; ETP-04 copia o total da pesquisa para etps', async () => {
    const { items, researchId, etp } = await background();
    const [cement, sand] = items;
    const saved = await putItems(
      etp.documentId,
      [
        { processItemId: cement?.id, quantity: '500', calculationMemo: paragraph(MEMO) },
        { processItemId: sand?.id, quantity: '400' },
      ],
      etp.documentVersion + 1,
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(
      await db.admin(
        `SELECT quantity::text AS quantity, calculation_memo FROM document_items
          WHERE document_id = $1 AND process_item_id = $2`,
        [etp.documentId, cement?.id],
      ),
    ).toEqual([{ quantity: '500.0000', calculation_memo: paragraph(MEMO) }]);
    const itemAudits = await auditsOf(etp.documentId, 'document.items_update');
    expect(JSON.stringify(itemAudits.at(-1)?.changes)).toContain('calculationMemo');
    expect(JSON.stringify(itemAudits)).not.toContain('Consumo médio');

    const linked = await patchEtp(
      etp.id,
      { estimatedValueSource: 'PRICE_RESEARCH', priceResearchId: researchId },
      etp.version,
    );
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    expect(etpDetailSchema.parse((linked.body as { data: unknown }).data)).toMatchObject({
      estimatedValueSource: 'PRICE_RESEARCH',
      estimatedTotalValue: '125000.00',
    });
    expect(await etpRow(etp.id)).toEqual({
      value: '125000.00',
      source: 'PRICE_RESEARCH',
      price_research_id: researchId,
      version: etp.version + 1,
    });
    expect(
      (await auditsOf(etp.documentId, 'document.draft_update')).at(-1)?.metadata,
    ).toMatchObject({
      target: 'HEADER',
      estimatedValueSource: 'PRICE_RESEARCH',
      priceResearchId: researchId,
    });
  });

  it('[Tenant incorreto] pesquisa da Prefeitura B → 422 REFERENCE_NOT_FOUND sem revelar; ETP de A visto de B → 404; a RLS de B não vê o ETP', async () => {
    const { etp } = await background();
    const foreign = await patchEtp(
      etp.id,
      { estimatedValueSource: 'PRICE_RESEARCH', priceResearchId: RESEARCH_B },
      etp.version,
    );
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(422);
    const problem = problemDetailsSchema.parse(foreign.body);
    expect(problem.errors).toEqual([
      expect.objectContaining({ field: 'priceResearchId', code: 'REFERENCE_NOT_FOUND' }),
    ]);
    expect(JSON.stringify(foreign.body)).not.toContain('777777');
    expect(JSON.stringify(foreign.body)).not.toContain('PP 0009/2026');
    expect(await etpRow(etp.id)).toMatchObject({ source: null, version: etp.version });

    const fromB = await patchEtp(
      etp.id,
      { estimatedValueSource: 'MANUAL', estimatedTotalValue: '1.00' },
      etp.version,
      SUBJECTS.beto,
    );
    expect(fromB.status, JSON.stringify(fromB.body)).toBe(404);
    expect(problemDetailsSchema.parse(fromB.body).code).toBe('NOT_FOUND');
    expect(await etpRow(etp.id)).toMatchObject({ source: null, version: etp.version });

    const client = db.client('cf_app');
    try {
      const visible = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$queryRaw<{ count: number }[]>`
            SELECT (SELECT count(*)::int FROM etps WHERE id = ${etp.id}::uuid)
                 + (SELECT count(*)::int FROM document_items WHERE document_id = ${etp.documentId}::uuid)
              AS count`,
        ),
      );
      expect(visible).toEqual([{ count: 0 }]);
    } finally {
      await client.$disconnect();
    }
  });

  it('[Concorrência] 5 PATCHes simultâneos com o mesmo If-Match: exatamente um 200, os demais 412', async () => {
    const { etp } = await background();
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        patchEtp(
          etp.id,
          { estimatedValueSource: 'MANUAL', estimatedTotalValue: `${String(1000 + index)}.00` },
          etp.version,
        ),
      ),
    );
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 412)).toHaveLength(4);
    for (const response of responses.filter((candidate) => candidate.status === 412)) {
      expect(problemDetailsSchema.parse(response.body).code).toBe('VERSION_CONFLICT');
    }
    expect(await etpRow(etp.id)).toMatchObject({ source: 'MANUAL', version: etp.version + 1 });
  });

  it('[Falha de integração] recálculo da pesquisa vinculada (PRS-20): PriceResearchRecalculated PENDING no outbox e o ETP intacto até o worker', async () => {
    const { process, researchId, etp } = await background({ finalized: false });
    const linked = await patchEtp(
      etp.id,
      { estimatedValueSource: 'PRICE_RESEARCH', priceResearchId: researchId },
      etp.version,
    );
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    await moveTo(process.id, 'PESQUISA_PRECOS');
    const recalculated = await call(
      request(api.server).post(`/api/v1/price-research/${researchId}/recalculate`),
    ).send({});
    expect(recalculated.status, JSON.stringify(recalculated.body)).toBe(200);
    const events = await db.admin<{ status: string }>(
      `SELECT status::text AS status FROM outbox_events
        WHERE event_type = 'PriceResearchRecalculated' AND aggregate_id = $1
        ORDER BY occurred_at DESC LIMIT 1`,
      [researchId],
    );
    expect(events).toEqual([{ status: 'PENDING' }]);
    // A API não sincroniza: o valor do ETP muda só quando o worker consome o evento.
    expect(await etpRow(etp.id)).toMatchObject({
      value: '125000.00',
      source: 'PRICE_RESEARCH',
      version: etp.version + 1,
    });
  });
});
