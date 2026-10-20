// Termo de Referência sobre PostgreSQL real (US-036 · Sucesso, Permissão, Tenant incorreto,
// Concorrência, Falha de banco, Falha de integração): a API inteira como `cf_app` (RLS) com os
// seeders reais do provisionamento, o processo criado pelo PRC-02 (Ana) com um item, a pesquisa de
// preços criada pelo PRS-02 (Rui) e levada (SQL) a FINALIZED com o total — a conclusão é da US-032 —
// e o processo levado (SQL) à etapa TERMO_REFERENCIA com o Rui (PLANEJAMENTO) responsável. Prova a
// criação numa transação só — falha induzida DEPOIS de numerar não deixa documento, cabeçalho,
// timeline, auditoria, evento nem número —, o vínculo automático com a pesquisa concluída, o índice
// único do tipo singular sob 10 criações paralelas, o evento `PENDING`, a POL-09 no orçamento
// sigiloso e a RLS/checks/FKs compostas de `terms_of_reference`.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type {
  PriceResearchDto,
  ProcessDto,
  TermDetailDto,
  TermDto,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
import { PRICE_RESEARCH_CLOCK } from '../../src/modules/price-research/application/ports.js';
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

const A = '0192c036-0000-7000-8000-00000000010a';
const B = '0192c036-0000-7000-8000-00000000010b';
const ORG_A = '0192c036-0000-7000-8000-0000000010a0';
const ORG_B = '0192c036-0000-7000-8000-0000000010b0';
const OBRAS = '0192c036-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c036-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c036-0000-7000-8000-0000000010b1';
const ANA = '0192c036-0000-7000-8000-0000000010c1';
const RUI = '0192c036-0000-7000-8000-0000000010c2';
const BETO = '0192c036-0000-7000-8000-0000000010c3';
const LIA = '0192c036-0000-7000-8000-0000000010c4';
const ANA_M = '0192c036-0000-7000-8000-0000000010d1';
const NOW = new Date('2026-10-19T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [RUI]: ['PLANEJAMENTO'],
  [BETO]: ['PLANEJAMENTO'],
  [LIA]: ['SOMENTE_LEITURA'],
};

const SUBJECTS = {
  ana: 'sub-ana-us036',
  rui: 'sub-rui-us036',
  beto: 'sub-beto-us036',
  lia: 'sub-lia-us036',
} as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us036', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'santa-luzia-us036', 'Prefeitura de Santa Luzia LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
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
  ('${ANA}', '${SUBJECTS.ana}', 'ana@a.test', true, 'Ana Souza'),
  ('${RUI}', '${SUBJECTS.rui}', 'rui@a.test', true, 'Rui Costa'),
  ('${BETO}', '${SUBJECTS.beto}', 'beto@b.test', true, 'Beto LEAK-B'),
  ('${LIA}', '${SUBJECTS.lia}', 'lia@a.test', true, 'Lia Consultora');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c036-0000-7000-8000-0000000010d2', '${A}', '${RUI}', 'INTERNAL', 'ACTIVE'),
  ('0192c036-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE'),
  ('0192c036-0000-7000-8000-0000000010d4', '${A}', '${LIA}', 'EXTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c036-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
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

describe('Feature: Criar TR sobre PostgreSQL (US-036)', () => {
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
   * Processo (PRC-02, Ana) com um item; com `research`, a pesquisa (PRS-02, Rui) FINALIZED com o
   * total de 98000.00; levado ao TERMO_REFERENCIA com o Rui.
   */
  const createProcess = async (options: { research?: boolean; confidential?: boolean } = {}) => {
    const response = await call(request(api.server).post('/api/v1/processes'), SUBJECTS.ana)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Notebooks ${words(2)}`,
        object: `Aquisição de notebooks para as escolas ${words(2)}`,
        contractingTypeId: catalog.contractingType,
        requestingSecretariatId: OBRAS,
        requestingDepartmentId: MANUTENCAO,
        originId: catalog.origin,
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const process = (response.body as { data: ProcessDto }).data;
    const item = await call(
      request(api.server).post(`/api/v1/processes/${process.id}/items`),
      SUBJECTS.ana,
    )
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'GOOD', description: 'Notebook 14 polegadas', unitOfMeasureId: catalog.un });
    expect(item.status, JSON.stringify(item.body)).toBe(201);
    let researchId: string | null = null;
    if (options.research === true) {
      await moveTo(process.id, 'PESQUISA_PRECOS');
      const created = await call(
        request(api.server).post(`/api/v1/processes/${process.id}/price-research`),
      )
        .set('Idempotency-Key', randomUUID())
        .send({});
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      researchId = (created.body as { data: PriceResearchDto }).data.id;
      await db.admin(
        `UPDATE price_research SET total_estimated_value = 98000.00, completed_at = now(),
                completed_by_id = $2
          WHERE id = $1`,
        [researchId, RUI],
      );
      await db.admin(
        `UPDATE documents SET status = 'FINALIZED', finalized_at = now(), finalized_by_id = $2,
                version = version + 1
          WHERE id = $1`,
        [researchId, RUI],
      );
    }
    if (options.confidential === true) {
      await db.admin('UPDATE processes SET is_budget_confidential = true WHERE id = $1', [
        process.id,
      ]);
    }
    await moveTo(process.id, 'TERMO_REFERENCIA');
    return { process, researchId };
  };
  const createTerm = (processId: string, body: Record<string, unknown> = {}, key = randomUUID()) =>
    call(request(api.server).post(`/api/v1/processes/${processId}/terms`))
      .set('Idempotency-Key', key)
      .send(body);
  const catalogId = async (tenantId: string, type: string, code: string) => {
    const [row] = await db.admin<{ id: string }>(
      'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
      [tenantId, type, code],
    );
    if (!row) throw new Error(`${type}/${code} ausente`);
    return row.id;
  };
  const lastNumber = async () => {
    const [row] = await db.admin<{ last_value: number }>(
      "SELECT last_value FROM number_sequences WHERE tenant_id = $1 AND sequence_key = 'DOCUMENT:TR:*:2026'",
      [A],
    );
    return row?.last_value ?? 0;
  };
  /** Tudo o que a criação do TR grava no processo (para provar o rollback). */
  const effects = async (processId: string) => ({
    documents: await db.admin<Row>(
      `SELECT d.id, d.code, d.status::text, d.confidentiality::text, d.version FROM documents d
         JOIN document_types t ON t.id = d.document_type_id
        WHERE d.process_id = $1 AND t.code = 'TR' ORDER BY d.created_at, d.id`,
      [processId],
    ),
    terms: await db.admin<Row>(
      `SELECT id, document_id, object_definition, estimated_total_value::text,
              estimated_value_source::text, price_research_id, version
         FROM terms_of_reference WHERE process_id = $1`,
      [processId],
    ),
    timeline: await db.admin<Row>(
      `SELECT count(*)::int AS count FROM process_timeline_entries t
         JOIN documents d ON d.id = t.entity_id
         JOIN document_types dt ON dt.id = d.document_type_id
        WHERE t.process_id = $1 AND t.type = 'DOCUMENT_CREATED' AND dt.code = 'TR'`,
      [processId],
    ),
    audit: await db.admin<Row>(
      `SELECT action, changes FROM audit_logs
        WHERE process_id = $1 AND action = 'document.create' AND metadata->>'documentTypeCode' = 'TR'`,
      [processId],
    ),
    events: await db.admin<Row>(
      `SELECT event_type, routing_key, status::text FROM outbox_events
        WHERE process_id = $1 AND routing_key = 'document.created.tr'`,
      [processId],
    ),
  });

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
        { token: PRICE_RESEARCH_CLOCK, value: () => NOW },
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
    };
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] TRM-02 numa transação: documento + cabeçalho vinculado à pesquisa concluída, número, timeline, auditoria e DocumentCreated PENDING', async () => {
    const { process, researchId } = await createProcess({ research: true });
    const before = await lastNumber();
    const created = await createTerm(process.id);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const term = (created.body as { data: TermDto }).data;
    const code = `TR ${String(before + 1).padStart(4, '0')}/2026`;
    expect(term).toMatchObject({ code, status: 'DRAFT', documentId: term.id });
    expect(created.headers.location).toBe(`/api/v1/terms/${term.id}`);
    expect(await lastNumber()).toBe(before + 1);

    const after = await effects(process.id);
    expect(after.documents).toEqual([
      {
        id: term.id,
        code,
        status: 'DRAFT',
        confidentiality: expect.any(String) as unknown,
        version: 1,
      },
    ]);
    expect(after.terms).toEqual([
      {
        id: term.id,
        document_id: term.id,
        object_definition: process.object,
        estimated_total_value: '98000.00',
        estimated_value_source: 'PRICE_RESEARCH',
        price_research_id: researchId,
        version: 1,
      },
    ]);
    const [sections] = await db.admin<{ count: number }>(
      `SELECT count(*)::int AS count FROM documents d, jsonb_object_keys(d.draft_content->'sections')
        WHERE d.id = $1`,
      [term.id],
    );
    expect(sections).toEqual({ count: 15 });
    expect(after.timeline).toEqual([{ count: 1 }]);
    expect(after.audit).toEqual([
      { action: 'document.create', changes: [{ path: 'documentTypeCode', old: null, new: 'TR' }] },
    ]);
    // [Falha de integração] relay fora: o evento fica PENDING para publicação (uma linha só).
    expect(after.events).toEqual([
      { event_type: 'DocumentCreated', routing_key: 'document.created.tr', status: 'PENDING' },
    ]);

    // TRM-03/04 sobre o banco: seção, objeto e o valor manual.
    const detail = await call(request(api.server).get(`/api/v1/terms/${term.id}`));
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect((detail.body as { data: TermDetailDto }).data.completeness.required).toBe(15);
    const patched = await call(request(api.server).patch(`/api/v1/terms/${term.id}`))
      .set('If-Match', '"1"')
      .send({ estimatedValueSource: 'MANUAL', estimatedTotalValue: '100000.00' });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect((await effects(process.id)).terms).toEqual([
      expect.objectContaining({
        estimated_total_value: '100000.00',
        estimated_value_source: 'MANUAL',
        price_research_id: null,
        version: 2,
      }),
    ]);
  });

  it('[Permissão] POL-09: orçamento sigiloso — RESTRICTED e valor mascarado para a consultora participante', async () => {
    const { process } = await createProcess({ research: true, confidential: true });
    const term = ((await createTerm(process.id)).body as { data: TermDto }).data;
    expect((await effects(process.id)).documents).toEqual([
      expect.objectContaining({ confidentiality: 'RESTRICTED' }),
    ]);
    await db.admin(
      `INSERT INTO process_participants (id, tenant_id, process_id, user_id, role, granted_by_id)
       VALUES ($1, $2, $3, $4, 'CONSULTANT', $5)`,
      [randomUUID(), A, process.id, LIA, RUI],
    );
    const masked = await call(request(api.server).get(`/api/v1/terms/${term.id}`), SUBJECTS.lia);
    expect(masked.status, JSON.stringify(masked.body)).toBe(200);
    expect((masked.body as { data: TermDetailDto }).data).toMatchObject({
      estimatedTotalValue: null,
      estimatedTotalValueMasked: true,
    });
    expect(JSON.stringify(masked.body)).not.toContain('98000');
  });

  it('[Concorrência] 10 criações simultâneas no mesmo processo: 1 × 201 e 9 × 409, numeração sem lacuna', async () => {
    const { process } = await createProcess();
    const before = await lastNumber();
    const responses = await Promise.all(Array.from({ length: 10 }, () => createTerm(process.id)));
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(9);
    for (const response of responses.filter((item) => item.status === 409)) {
      expect(problemDetailsSchema.parse(response.body).code).toBe('DOCUMENT_ALREADY_EXISTS');
    }
    expect((await effects(process.id)).terms).toHaveLength(1);
    expect(await lastNumber()).toBe(before + 1);
  });

  it('[Falha de banco] falha induzida DEPOIS de numerar desfaz tudo, inclusive o número', async () => {
    const { process } = await createProcess();
    const before = await lastNumber();
    await db.admin(`
      CREATE FUNCTION test_fail_terms_insert() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        RAISE EXCEPTION 'falha induzida no teste';
      END $fn$;
      CREATE TRIGGER test_fail_terms_insert BEFORE INSERT ON terms_of_reference
        FOR EACH ROW EXECUTE FUNCTION test_fail_terms_insert();`);
    try {
      const failed = await createTerm(process.id);
      expect(failed.status).toBe(500);
      expect(await effects(process.id)).toEqual({
        documents: [],
        terms: [],
        timeline: [{ count: 0 }],
        audit: [],
        events: [],
      });
      expect(await lastNumber()).toBe(before);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_terms_insert ON terms_of_reference; DROP FUNCTION test_fail_terms_insert();',
      );
    }
    const created = await createTerm(process.id);
    expect((created.body as { data: TermDto }).data.code).toBe(
      `TR ${String(before + 1).padStart(4, '0')}/2026`,
    );
  });

  it('[Tenant incorreto] TR de A pelo tenant B: 404 sem alterar; template de B: 422; RLS, checks e FKs compostas', async () => {
    const { process } = await createProcess();
    const term = ((await createTerm(process.id)).body as { data: TermDto }).data;
    const before = await effects(process.id);

    const asBeto = (test: request.Test) => call(test, SUBJECTS.beto);
    for (const response of [
      await asBeto(request(api.server).get(`/api/v1/processes/${process.id}/terms`)),
      await asBeto(request(api.server).get(`/api/v1/terms/${term.id}`)),
      await asBeto(request(api.server).patch(`/api/v1/terms/${term.id}`))
        .set('If-Match', '"1"')
        .send({ objectDefinition: 'Objeto alterado pelo tenant B' }),
      await asBeto(request(api.server).post(`/api/v1/processes/${process.id}/terms`))
        .set('Idempotency-Key', randomUUID())
        .send({}),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain(term.code ?? '#');
    }
    expect(await effects(process.id)).toEqual(before);

    // Template do tenant B na criação em A: 422 REFERENCE_NOT_FOUND (RLS — invisível).
    const other = await createProcess();
    const [templateOfB] = await db.admin<{ id: string }>(
      `SELECT t.id FROM document_templates t JOIN document_types dt ON dt.id = t.document_type_id
        WHERE t.tenant_id = $1 AND dt.code = 'TR' LIMIT 1`,
      [B],
    );
    const refused = await createTerm(other.process.id, { templateId: templateOfB?.id });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(problemDetailsSchema.parse(refused.body).errors).toEqual([
      expect.objectContaining({ field: 'templateId', code: 'REFERENCE_NOT_FOUND' }),
    ]);

    // RLS: com `app.tenant_id` de B, nenhum TR de A é visível nem alterável.
    const client = db.client('cf_app');
    try {
      const visible = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$queryRaw<{ count: number }[]>`
            SELECT count(*)::int AS count FROM terms_of_reference WHERE id = ${term.id}::uuid`,
        ),
      );
      expect(visible).toEqual([{ count: 0 }]);
      const updated = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$executeRaw`
            UPDATE terms_of_reference SET object_definition = 'x' WHERE id = ${term.id}::uuid`,
        ),
      );
      expect(updated).toBe(0);
    } finally {
      await client.$disconnect();
    }

    const insertTerm = (tenantId: string, id: string, documentId: string) =>
      db.admin(
        `INSERT INTO terms_of_reference (id, tenant_id, process_id, document_id, object_definition)
         VALUES ($1, $2, $3, $4, 'Objeto do TR')`,
        [id, tenantId, process.id, documentId],
      );
    // 1:1 com o documento.
    await expect(insertTerm(A, randomUUID(), term.id)).rejects.toThrow();
    // FK composta: cabeçalho no tenant B apontando para documento/processo de A é recusado.
    await expect(insertTerm(B, term.id, term.id)).rejects.toThrow();
    // CHECKs (origem PRICE_RESEARCH sem pesquisa, limites, garantia, prazo sem tipo) e imutáveis.
    for (const sql of [
      "UPDATE terms_of_reference SET estimated_value_source = 'PRICE_RESEARCH', price_research_id = NULL WHERE id = $1",
      "UPDATE terms_of_reference SET estimated_value_source = 'DFD' WHERE id = $1",
      'UPDATE terms_of_reference SET estimated_total_value = -1 WHERE id = $1',
      'UPDATE terms_of_reference SET contract_guarantee_percent = 10.5 WHERE id = $1',
      'UPDATE terms_of_reference SET payment_term_days = 91 WHERE id = $1',
      'UPDATE terms_of_reference SET execution_deadline = 30, execution_deadline_type = NULL WHERE id = $1',
      'UPDATE terms_of_reference SET price_research_id = gen_random_uuid() WHERE id = $1',
    ]) {
      await expect(db.admin(sql, [term.id]), sql).rejects.toThrow();
    }
    await expect(
      db.admin('UPDATE terms_of_reference SET document_id = $2 WHERE id = $1', [
        term.id,
        randomUUID(),
      ]),
    ).rejects.toThrow();
  });
});
