// ETP sobre PostgreSQL real (US-019 · Sucesso, Tenant incorreto, Concorrência, Falha de banco,
// Falha de integração): a API inteira como `cf_app` (RLS) com os seeders reais do provisionamento, o
// processo criado pelo PRC-02 (Ana), o DFD criado pelo DFD-02 e levado (SQL) a FINALIZED com o
// snapshot da versão — o ciclo do DFD é da US-016/065 —, e o processo levado (SQL) à etapa
// ESTUDOS_PRELIMINARES com o Rui (PLANEJAMENTO) responsável. Prova a criação numa transação só —
// falha induzida DEPOIS de numerar e importar não deixa documento, itens, cabeçalho, timeline,
// auditoria, evento nem número —, o índice único do tipo singular sob 10 criações paralelas, o
// evento `PENDING` e a RLS/checks/FKs compostas de `etps`.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { DfdDto, EtpDto, ProcessDto, ProcessItemDto } from '@contrataflow/validation';
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

const A = '0192c019-0000-7000-8000-00000000010a';
const B = '0192c019-0000-7000-8000-00000000010b';
const ORG_A = '0192c019-0000-7000-8000-0000000010a0';
const ORG_B = '0192c019-0000-7000-8000-0000000010b0';
const OBRAS = '0192c019-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c019-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c019-0000-7000-8000-0000000010b1';
const ANA = '0192c019-0000-7000-8000-0000000010c1';
const RUI = '0192c019-0000-7000-8000-0000000010c2';
const BETO = '0192c019-0000-7000-8000-0000000010c3';
const ANA_M = '0192c019-0000-7000-8000-0000000010d1';
const NOW = new Date('2026-10-18T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [RUI]: ['PLANEJAMENTO'],
  [BETO]: ['PLANEJAMENTO'],
};

const SUBJECTS = { ana: 'sub-ana-us019', rui: 'sub-rui-us019', beto: 'sub-beto-us019' } as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us019', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'santa-luzia-us019', 'Prefeitura de Santa Luzia LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
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
  ('${BETO}', '${SUBJECTS.beto}', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c019-0000-7000-8000-0000000010d2', '${A}', '${RUI}', 'INTERNAL', 'ACTIVE'),
  ('0192c019-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c019-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
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

describe('Feature: Criar ETP sobre PostgreSQL (US-019)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: { contractingType: string; origin: string; un: string };

  const tenantOf = (subject: string): string => (subject === SUBJECTS.beto ? B : A);
  const call = (test: request.Test, subject: string = SUBJECTS.rui) =>
    test
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));

  /**
   * Processo (PRC-02, Ana) com dois itens e o DFD (DFD-02, Ana) FINALIZED com a versão 1 (snapshot
   * com objeto, justificativa, PCA e os itens 7 e 3), levado aos ESTUDOS_PRELIMINARES com o Rui.
   */
  const createProcess = async () => {
    const response = await call(request(api.server).post('/api/v1/processes'), SUBJECTS.ana)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Manutenção predial ${words(2)}`,
        object: `Contratação de manutenção predial preventiva ${words(2)}`,
        contractingTypeId: catalog.contractingType,
        requestingSecretariatId: OBRAS,
        requestingDepartmentId: MANUTENCAO,
        originId: catalog.origin,
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const process = (response.body as { data: ProcessDto }).data;
    const items: ProcessItemDto[] = [];
    for (const description of ['Tinta acrílica 18 L', 'Massa corrida 25 kg']) {
      const item = await call(
        request(api.server).post(`/api/v1/processes/${process.id}/items`),
        SUBJECTS.ana,
      )
        .set('Idempotency-Key', randomUUID())
        .send({ kind: 'GOOD', description, unitOfMeasureId: catalog.un });
      expect(item.status, JSON.stringify(item.body)).toBe(201);
      items.push((item.body as { data: ProcessItemDto }).data);
    }
    const dfdResponse = await call(
      request(api.server).post(`/api/v1/processes/${process.id}/dfds`),
      SUBJECTS.ana,
    )
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(dfdResponse.status, JSON.stringify(dfdResponse.body)).toBe(201);
    const dfd = (dfdResponse.body as { data: DfdDto }).data;
    const quantities = ['7.0000', '3.0000'];
    for (const [index, item] of items.entries()) {
      await db.admin(
        `INSERT INTO document_items (id, tenant_id, document_id, process_item_id, quantity, sort_order)
         VALUES ($1, $2, $3, $4, $5::numeric, $6)`,
        [randomUUID(), A, dfd.documentId, item.id, quantities[index], index],
      );
    }
    const versionId = randomUUID();
    const snapshot = {
      schemaVersion: 1,
      document: {
        id: dfd.documentId,
        code: dfd.code,
        title: dfd.title,
        typeCode: 'DFD',
        kind: 'STRUCTURED',
        confidentiality: 'INTERNAL',
        versionNumber: 1,
      },
      template: null,
      process: {
        id: process.id,
        code: process.code,
        title: process.title,
        object: process.object,
        organizationName: 'Prefeitura Municipal de São José',
        organizationCnpj: null,
        requestingSecretariatName: null,
        requestingDepartmentName: null,
        isBudgetConfidential: false,
      },
      header: {
        objectSummary: 'Manutenção predial preventiva',
        pcaStatus: 'PLANNED',
        pcaYear: 2026,
        pcaItemCode: 'PCA-9',
        pcaJustification: null,
      },
      sections: {
        JUSTIFICATION: {
          state: 'FILLED',
          justification: null,
          content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Infiltrações.' }] }],
          },
        },
      },
      collections: {
        items: items.map((item, index) => ({
          processItemId: item.id,
          quantity: quantities[index],
          notes: null,
          sortOrder: index,
        })),
      },
      generatedAt: NOW.toISOString(),
    };
    await db.admin(
      `INSERT INTO document_versions (id, tenant_id, document_id, process_id, version_number, reason,
                                      status_at_creation, content, content_hash, created_by_id)
       VALUES ($1, $2, $3, $4, 1, 'FINALIZATION', 'FINALIZED', $5::jsonb, $6, $7)`,
      [versionId, A, dfd.documentId, process.id, JSON.stringify(snapshot), 'c'.repeat(64), ANA],
    );
    await db.admin(
      `UPDATE documents SET status = 'FINALIZED', current_version_id = $2, finalized_at = now(),
              finalized_by_id = $3, version = version + 1
        WHERE id = $1`,
      [dfd.documentId, versionId, ANA],
    );
    await db.admin(
      `UPDATE processes p SET status = 'IN_PROGRESS', current_workflow_stage_id = ws.id,
              current_responsible_id = $2
         FROM workflow_stages ws
        WHERE p.id = $1 AND ws.workflow_version_id = p.workflow_version_id
          AND ws.key = 'ESTUDOS_PRELIMINARES'`,
      [process.id, RUI],
    );
    return { process, items, dfd, versionId };
  };
  const createEtp = (processId: string, key: string = randomUUID()) =>
    call(request(api.server).post(`/api/v1/processes/${processId}/etps`))
      .set('Idempotency-Key', key)
      .send({ importFromDfd: true });
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
      "SELECT last_value FROM number_sequences WHERE tenant_id = $1 AND sequence_key = 'DOCUMENT:ETP:*:2026'",
      [A],
    );
    return row?.last_value ?? 0;
  };
  /** Tudo o que a criação do ETP grava no processo (para provar o rollback). */
  const effects = async (processId: string) => ({
    documents: await db.admin<Row>(
      `SELECT d.id, d.code, d.status::text, d.version FROM documents d
         JOIN document_types t ON t.id = d.document_type_id
        WHERE d.process_id = $1 AND t.code = 'ETP' ORDER BY d.created_at, d.id`,
      [processId],
    ),
    etps: await db.admin<Row>(
      `SELECT id, document_id, conclusion::text, imported_from_dfd_version_id, version
         FROM etps WHERE process_id = $1`,
      [processId],
    ),
    items: await db.admin<Row>(
      `SELECT i.process_item_id, i.quantity::text, i.calculation_memo FROM document_items i
         JOIN etps e ON e.document_id = i.document_id
        WHERE e.process_id = $1 ORDER BY i.sort_order`,
      [processId],
    ),
    timeline: await db.admin<Row>(
      // Só a do ETP: o DFD do arranjo (DFD-02) também gera o seu DOCUMENT_CREATED.
      `SELECT count(*)::int AS count FROM process_timeline_entries t
         JOIN documents d ON d.id = t.entity_id
         JOIN document_types dt ON dt.id = d.document_type_id
        WHERE t.process_id = $1 AND t.type::text = 'DOCUMENT_CREATED' AND dt.code = 'ETP'`,
      [processId],
    ),
    audit: await db.admin<Row>(
      `SELECT action, changes FROM audit_logs
        WHERE process_id = $1 AND action = 'document.create' AND metadata->>'documentTypeCode' = 'ETP'`,
      [processId],
    ),
    events: await db.admin<Row>(
      `SELECT event_type, routing_key, status::text FROM outbox_events
        WHERE process_id = $1 AND routing_key = 'document.created.etp'`,
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
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] ETP-02 numa transação: documento + cabeçalho (id = documento), seções e itens importados, número, timeline, auditoria e DocumentCreated PENDING', async () => {
    const { process, items, versionId } = await createProcess();
    const before = await lastNumber();
    const created = await createEtp(process.id);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const etp = (created.body as { data: EtpDto }).data;
    const code = `ETP ${String(before + 1).padStart(4, '0')}/2026`;
    expect(etp).toMatchObject({ code, status: 'DRAFT', documentId: etp.id, itemsCount: 2 });
    expect(created.headers.etag).toBe('"1"');
    expect(await lastNumber()).toBe(before + 1);

    const after = await effects(process.id);
    expect(after.documents).toEqual([{ id: etp.id, code, status: 'DRAFT', version: 1 }]);
    expect(after.etps).toEqual([
      {
        id: etp.id,
        document_id: etp.id,
        conclusion: 'PENDING',
        imported_from_dfd_version_id: versionId,
        version: 1,
      },
    ]);
    expect(after.items).toEqual([
      { process_item_id: items[0]?.id, quantity: '7.0000', calculation_memo: null },
      { process_item_id: items[1]?.id, quantity: '3.0000', calculation_memo: null },
    ]);
    const [sections] = await db.admin<{ need: string; pca: string; problem: string }>(
      `SELECT draft_content->'sections'->'NEED_DESCRIPTION'->>'state' AS need,
              draft_content->'sections'->'PCA_ALIGNMENT'->>'state' AS pca,
              draft_content->'sections'->'PROBLEM'->>'state' AS problem
         FROM documents WHERE id = $1`,
      [etp.id],
    );
    expect(sections).toEqual({ need: 'FILLED', pca: 'FILLED', problem: 'EMPTY' });
    expect(after.timeline).toEqual([{ count: 1 }]);
    expect(after.audit).toEqual([
      {
        action: 'document.create',
        changes: [
          { path: 'documentTypeCode', old: null, new: 'ETP' },
          { path: 'importedFromDfdVersionId', old: null, new: versionId },
        ],
      },
    ]);
    // [Falha de integração] relay fora: o evento fica PENDING para publicação (uma linha só).
    expect(after.events).toEqual([
      { event_type: 'DocumentCreated', routing_key: 'document.created.etp', status: 'PENDING' },
    ]);
  });

  it('[Concorrência] 10 criações simultâneas no mesmo processo: 1 × 201 e 9 × 409, numeração sem lacuna', async () => {
    const { process } = await createProcess();
    const before = await lastNumber();
    const responses = await Promise.all(Array.from({ length: 10 }, () => createEtp(process.id)));
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(9);
    for (const response of responses.filter((item) => item.status === 409)) {
      expect(problemDetailsSchema.parse(response.body).code).toBe('DOCUMENT_ALREADY_EXISTS');
    }
    const after = await effects(process.id);
    expect(after.etps).toHaveLength(1);
    expect(after.items).toHaveLength(2);
    expect(await lastNumber()).toBe(before + 1);
  });

  it('[Falha de banco] falha induzida DEPOIS de numerar e importar desfaz tudo, inclusive o número', async () => {
    const { process } = await createProcess();
    const before = await lastNumber();
    await db.admin(`
      CREATE FUNCTION test_fail_etps_insert() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        RAISE EXCEPTION 'falha induzida no teste';
      END $fn$;
      CREATE TRIGGER test_fail_etps_insert BEFORE INSERT ON etps
        FOR EACH ROW EXECUTE FUNCTION test_fail_etps_insert();`);
    try {
      const failed = await createEtp(process.id);
      expect(failed.status).toBe(500);
      expect(await effects(process.id)).toEqual({
        documents: [],
        etps: [],
        items: [],
        timeline: [{ count: 0 }],
        audit: [],
        events: [],
      });
      expect(await lastNumber()).toBe(before);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_etps_insert ON etps; DROP FUNCTION test_fail_etps_insert();',
      );
    }
    const created = await createEtp(process.id);
    expect((created.body as { data: EtpDto }).data.code).toBe(
      `ETP ${String(before + 1).padStart(4, '0')}/2026`,
    );
  });

  it('[Tenant incorreto] processo e ETP de A pelo tenant B: 404 sem alterar; RLS, checks e FKs compostas', async () => {
    const { process, versionId } = await createProcess();
    const etp = ((await createEtp(process.id)).body as { data: EtpDto }).data;
    const before = await effects(process.id);

    const asBeto = (test: request.Test) => call(test, SUBJECTS.beto);
    for (const response of [
      await asBeto(request(api.server).get(`/api/v1/processes/${process.id}/etps`)),
      await asBeto(request(api.server).post(`/api/v1/processes/${process.id}/etps`))
        .set('Idempotency-Key', randomUUID())
        .send({ importFromDfd: true }),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain(etp.code ?? '#');
    }
    expect(await effects(process.id)).toEqual(before);

    // RLS: com `app.tenant_id` de B, nenhum ETP de A é visível nem alterável.
    const client = db.client('cf_app');
    try {
      const visible = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$queryRaw<{ count: number }[]>`
            SELECT count(*)::int AS count FROM etps WHERE id = ${etp.id}::uuid`,
        ),
      );
      expect(visible).toEqual([{ count: 0 }]);
      const updated = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$executeRaw`
            UPDATE etps SET conclusion = 'VIABLE' WHERE id = ${etp.id}::uuid`,
        ),
      );
      expect(updated).toBe(0);
    } finally {
      await client.$disconnect();
    }

    const insertEtp = (tenantId: string, id: string, documentId: string, dfdVersionId: string) =>
      db.admin(
        `INSERT INTO etps (id, tenant_id, process_id, document_id, imported_from_dfd_version_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, tenantId, process.id, documentId, dfdVersionId],
      );
    // 1:1 com o documento.
    await expect(insertEtp(A, randomUUID(), etp.id, versionId)).rejects.toThrow();
    // FK composta: cabeçalho no tenant B apontando para documento/versão de A é recusado.
    await expect(insertEtp(B, etp.id, etp.id, versionId)).rejects.toThrow();
    // CHECKs e colunas imutáveis.
    await expect(
      db.admin(`UPDATE etps SET estimated_value_source = 'DFD' WHERE id = $1`, [etp.id]),
    ).rejects.toThrow();
    await expect(
      db.admin('UPDATE etps SET estimated_total_value = -1 WHERE id = $1', [etp.id]),
    ).rejects.toThrow();
    await expect(
      db.admin('UPDATE etps SET document_id = $2 WHERE id = $1', [etp.id, randomUUID()]),
    ).rejects.toThrow();
  });
});
