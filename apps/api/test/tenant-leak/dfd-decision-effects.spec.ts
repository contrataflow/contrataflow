// Efeitos da decisão sobre o DFD sobre PostgreSQL real (US-017 · Sucesso, Falha de banco, Tenant
// incorreto e Falha de integração): a API inteira como `cf_app` (RLS) com os seeders reais do
// provisionamento (workflow padrão DEC-015 — ABERTURA → APROVACAO_DFD com o titular da
// secretaria). O DFD é preenchido pelas rotas e enviado pelo PRC-19; a titular decide pelo APV-03.
// APPROVE propaga valor, PCA, prioridade e `reference_quantity` na MESMA transação da decisão, com
// `process.update`/`process.items_update` (`metadata.source = DFD_APPROVAL`) e o `DocumentApproved`
// `PENDING` no outbox (sem relay no teste). Uma falha de banco induzida DEPOIS de gravar a
// quantidade de referência desfaz tudo (DFD IN_REVIEW, aprovação PENDING, processo e item intactos);
// a aprovação de A não existe para o tenant B (404 e RLS). `pnpm --filter @contrataflow/api
// test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type {
  DfdDto,
  ForwardedProcessDto,
  ProcessDto,
  ProcessItemDto,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { PrismaProcessItemRepository } from '#modules/process/infrastructure/process-item.repositories.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';

import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
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

const A = '0192c017-0000-7000-8000-00000000010a';
const B = '0192c017-0000-7000-8000-00000000010b';
const ORG_A = '0192c017-0000-7000-8000-0000000010a0';
const ORG_B = '0192c017-0000-7000-8000-0000000010b0';
const OBRAS = '0192c017-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c017-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c017-0000-7000-8000-0000000010b1';
const ANA = '0192c017-0000-7000-8000-0000000010c1';
const MARTA = '0192c017-0000-7000-8000-0000000010c2';
const DAVI = '0192c017-0000-7000-8000-0000000010c3';
const BETO = '0192c017-0000-7000-8000-0000000010c6';
const ANA_M = '0192c017-0000-7000-8000-0000000010d1';
const NOW = new Date('2026-10-05T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [MARTA]: ['AUTORIDADE_COMPETENTE'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us017', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'santa-luzia-us017', 'Prefeitura de Santa Luzia LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura de Santa Luzia LEAK-B', 'PMSL', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', 'sub-ana-us017', 'ana@a.test', true, 'Cláudia Ferreira'),
  ('${MARTA}', 'sub-marta-us017', 'marta@a.test', true, 'Helena Prado'),
  ('${DAVI}', 'sub-davi-us017', 'davi@a.test', true, 'Paulo Mendes'),
  ('${BETO}', 'sub-beto-us017', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth, head_user_id, deputy_user_id) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0, '${MARTA}', '${DAVI}'),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1, NULL, NULL),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Obras LEAK-B', '${path(OBRAS_B)}', 0, NULL, NULL);
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c017-0000-7000-8000-0000000010d2', '${A}', '${MARTA}', 'INTERNAL', 'ACTIVE'),
  ('0192c017-0000-7000-8000-0000000010d3', '${A}', '${DAVI}', 'INTERNAL', 'ACTIVE'),
  ('0192c017-0000-7000-8000-0000000010d6', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c017-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
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

const richText = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe('Feature: Efeitos da decisão sobre o DFD sobre PostgreSQL (US-017)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: { contractingType: string; origin: string; unit: string };

  const as = (call: request.Test, subject = 'sub-ana-us017', tenant = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenant)
      .set('Idempotency-Key', randomUUID());
  const one = async <T extends Row>(sql: string, params: unknown[]): Promise<T> => {
    const [row] = await db.admin<T>(sql, params);
    if (!row) throw new Error(`sem linha: ${sql}`);
    return row;
  };
  const catalogItem = async (type: string, code: string) =>
    (
      await one<{ id: string }>(
        'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
        [A, type, code],
      )
    ).id;
  const transitionOf = async (processId: string, key: string) =>
    (
      await one<{ id: string }>(
        `SELECT t.id FROM workflow_transitions t JOIN processes p ON p.workflow_version_id = t.workflow_version_id
          WHERE p.id = $1 AND t.key = $2`,
        [processId, key],
      )
    ).id;

  /** Background: processo em APROVACAO_DFD com o DFD (15000.00, PCA PLANNED, 1 item × 10) IN_REVIEW. */
  async function inApproval(): Promise<{
    processId: string;
    documentId: string;
    itemId: string;
    approvalId: string;
  }> {
    const created = await as(request(api.server).post('/api/v1/processes')).send({
      title: `Compra ${words(2)}`,
      object: `Objeto ${words(3)}`,
      contractingTypeId: catalog.contractingType,
      requestingSecretariatId: OBRAS,
      requestingDepartmentId: MANUTENCAO,
      originId: catalog.origin,
      pcaStatus: 'NOT_APPLICABLE',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const processId = (created.body as { data: ProcessDto }).data.id;
    const item = await as(request(api.server).post(`/api/v1/processes/${processId}/items`)).send({
      kind: 'GOOD',
      description: 'Cimento CP II 50 kg',
      unitOfMeasureId: catalog.unit,
    });
    expect(item.status, JSON.stringify(item.body)).toBe(201);
    const itemId = (item.body as { data: ProcessItemDto }).data.id;
    const dfdResponse = await as(
      request(api.server).post(`/api/v1/processes/${processId}/dfds`),
    ).send({});
    expect(dfdResponse.status, JSON.stringify(dfdResponse.body)).toBe(201);
    const dfd = (dfdResponse.body as { data: DfdDto }).data;
    const items = await as(request(api.server).put(`/api/v1/documents/${dfd.documentId}/items`))
      .set('If-Match', '"1"')
      .send({ items: [{ processItemId: itemId, quantity: '10' }] });
    expect(items.status, JSON.stringify(items.body)).toBe(200);
    for (const [key, text] of [
      ['JUSTIFICATION', 'x'.repeat(380)],
      ['EXPECTED_RESULTS', 'Manutenção contínua das vias do bairro Centro.'],
    ] as const) {
      const section = await as(
        request(api.server).put(`/api/v1/documents/${dfd.documentId}/sections/${key}`),
      )
        .set('If-Match', '"s1"')
        .send({ content: richText(text), notApplicable: false, justification: null });
      expect(section.status, JSON.stringify(section.body)).toBe(200);
    }
    const header = await as(request(api.server).patch(`/api/v1/dfds/${dfd.id}`))
      .set('If-Match', `"${String(dfd.version)}"`)
      .send({
        expectedDate: '2026-12-15',
        pcaStatus: 'PLANNED',
        pcaYear: 2026,
        priority: 'HIGH',
        estimatedValue: '15000.00',
      });
    expect(header.status, JSON.stringify(header.body)).toBe(200);
    const process = (
      (await as(request(api.server).get(`/api/v1/processes/${processId}`))).body as {
        data: ProcessDto;
      }
    ).data;
    const forwarded = await as(request(api.server).post(`/api/v1/processes/${processId}/forward`))
      .set('If-Match', `"${String(process.version)}"`)
      .send({
        transitionId: await transitionOf(processId, 'ENVIAR_APROVACAO_DFD'),
        expectedStageId: process.currentStage?.id,
        acknowledgedWarnings: [],
      });
    expect(forwarded.status, JSON.stringify(forwarded.body)).toBe(200);
    const approvalId = (forwarded.body as { data: ForwardedProcessDto }).data.approval?.id ?? '';
    return { processId, documentId: dfd.documentId, itemId, approvalId };
  }

  const approve = async (approvalId: string, processId: string, subject = 'sub-marta-us017') =>
    as(
      request(api.server).post(`/api/v1/approvals/${approvalId}/decide`),
      subject,
      subject.includes('beto') ? B : A,
    )
      .set('If-Match', '"1"')
      .send({ decision: 'APPROVE', transitionId: await transitionOf(processId, 'APROVAR_DFD') });

  /** O que a decisão grava — para provar o rollback. */
  const effects = async (processId: string, approvalId: string) => ({
    process: await db.admin<Row>(
      `SELECT status::text, version, estimated_value::text, estimated_value_source::text,
              pca_status::text, pca_year, priority::text, current_stage_id
         FROM processes WHERE id = $1`,
      [processId],
    ),
    items: await db.admin<Row>(
      `SELECT reference_quantity::text, reference_quantity_source_document_id
         FROM process_items WHERE process_id = $1`,
      [processId],
    ),
    approval: await db.admin<Row>('SELECT status::text, version FROM approvals WHERE id = $1', [
      approvalId,
    ]),
    documents: await db.admin<Row>(
      'SELECT status::text, pending_approval_id FROM documents WHERE process_id = $1',
      [processId],
    ),
    audits: await db.admin<Row>(
      `SELECT action FROM audit_logs WHERE process_id = $1
          AND action IN ('process.update', 'process.items_update', 'approval.decide')`,
      [processId],
    ),
    events: await db.admin<Row>(
      `SELECT event_type FROM outbox_events WHERE process_id = $1
          AND event_type IN ('DocumentApproved', 'ProcessUpdated', 'ApprovalCompleted')`,
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
    await runTenantSeeders(api, A, [
      'catalog.items',
      'catalog.holidays',
      'access.defaultRoles',
      'document.systemTypes',
      'document.templateLibrary',
      'workflow.seedWorkflows',
    ]);
    await runTenantSeeders(api, B, ['catalog.items', 'access.defaultRoles']);
    catalog = {
      contractingType: await catalogItem('CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      origin: await catalogItem('PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
      unit: await catalogItem('UNIT_OF_MEASURE', 'UN'),
    };
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] APPROVE propaga valor, PCA, prioridade e quantidade na transação da decisão; auditoria de propagação; DFDApproved PENDING no outbox', async () => {
    const { processId, documentId, itemId, approvalId } = await inApproval();

    const response = await approve(approvalId, processId);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await one('SELECT status::text FROM documents WHERE id = $1', [documentId])).toEqual({
      status: 'APPROVED',
    });
    expect(
      await one(
        `SELECT estimated_value::text, estimated_value_source::text, pca_status::text, pca_year,
                priority::text FROM processes WHERE id = $1`,
        [processId],
      ),
    ).toEqual({
      estimated_value: '15000.00',
      estimated_value_source: 'DFD',
      pca_status: 'PLANNED',
      pca_year: 2026,
      priority: 'HIGH',
    });
    expect(
      await one(
        `SELECT reference_quantity::text, reference_quantity_source_document_id
           FROM process_items WHERE id = $1`,
        [itemId],
      ),
    ).toEqual({ reference_quantity: '10.0000', reference_quantity_source_document_id: documentId });
    const audits = await db.admin<{ action: string; metadata: Row }>(
      `SELECT action, metadata FROM audit_logs WHERE process_id = $1
          AND action IN ('process.update', 'process.items_update') ORDER BY action`,
      [processId],
    );
    expect(
      audits.filter((row) => row.metadata.source === 'DFD_APPROVAL').map((row) => row.action),
    ).toEqual(['process.items_update', 'process.update']);
    // Falha de integração: sem relay, o evento fica PENDING até ele voltar.
    expect(
      await db.admin(
        `SELECT routing_key, status::text FROM outbox_events
          WHERE process_id = $1 AND event_type = 'DocumentApproved'`,
        [processId],
      ),
    ).toEqual([{ routing_key: 'document.approved.dfd', status: 'PENDING' }]);
  });

  it('[Falha de banco] o banco falha DEPOIS de gravar a quantidade de referência: 503 e nada fica (DFD IN_REVIEW, aprovação PENDING, processo e item intactos)', async () => {
    const { processId, approvalId } = await inApproval();
    const before = await effects(processId, approvalId);
    const original = PrismaProcessItemRepository.prototype.updateReferenceQuantities.bind(
      api.app.get(PrismaProcessItemRepository),
    );
    const failing = vi
      .spyOn(PrismaProcessItemRepository.prototype, 'updateReferenceQuantities')
      .mockImplementation(async (...args) => {
        await original(...args);
        throw new DatabaseUnavailableError(new Error('ECONNRESET'));
      });
    try {
      const failed = await approve(approvalId, processId);
      expect(failed.status, JSON.stringify(failed.body)).toBe(503);
      expect(problemDetailsSchema.parse(failed.body).code).toBe('DEPENDENCY_UNAVAILABLE');
    } finally {
      failing.mockRestore();
    }
    const after = await effects(processId, approvalId);
    expect(after).toEqual(before);
    expect(after.documents).toEqual([{ status: 'IN_REVIEW', pending_approval_id: approvalId }]);
    expect(after.approval).toEqual([{ status: 'PENDING', version: 1 }]);
  });

  it('[Tenant incorreto] a decisão de A não existe para o tenant B: 404, nada muda e a RLS esconde processo, itens e DFD', async () => {
    const { processId, documentId, approvalId } = await inApproval();
    const before = await effects(processId, approvalId);

    const response = await approve(approvalId, processId, 'sub-beto-us017');

    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(problemDetailsSchema.parse(response.body).code).toBe('APPROVAL_NOT_FOUND');
    expect(await effects(processId, approvalId)).toEqual(before);
    const client = db.client('cf_app');
    try {
      const seen = await asTenant(B, () =>
        client.$tenantTransaction(async (tx) => ({
          processes: await tx.$queryRaw<
            Row[]
          >`SELECT id FROM processes WHERE id = ${processId}::uuid`,
          items: await tx.$queryRaw<
            Row[]
          >`SELECT id FROM process_items WHERE process_id = ${processId}::uuid`,
          dfds: await tx.$queryRaw<Row[]>`SELECT id FROM dfds WHERE id = ${documentId}::uuid`,
          audits: await tx.$queryRaw<
            Row[]
          >`SELECT id FROM audit_logs WHERE process_id = ${processId}::uuid`,
        })),
      );
      expect(seen).toEqual({ processes: [], items: [], dfds: [], audits: [] });
    } finally {
      await client.$disconnect();
    }
  });
});
