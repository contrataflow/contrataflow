// "Concluir e enviar para aprovação" sobre PostgreSQL real (US-016 · Sucesso, Tenant incorreto e
// Falha de banco): a API inteira como `cf_app` (RLS) com os seeders reais do provisionamento
// (workflow padrão DEC-015 — ABERTURA → APROVACAO_DFD com o titular da secretaria). O DFD é
// preenchido pelas rotas (DOC-07, DOC-05, DFD-04) e enviado pelo PRC-19 numa única transação:
// versão SUBMISSION com o `content_hash` do JSON canônico gravado, aprovação com a mensagem,
// cobertura da versão exata e tramitação. Uma falha de banco induzida ao gravar a aprovação desfaz
// tudo (DFD em DRAFT, nenhuma versão, processo na ABERTURA) e o processo de outro tenant é 404.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
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

import { PrismaApprovalRepository } from '#modules/approval/infrastructure/approval.repositories.js';
import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { canonicalJson, sha256Hex } from '#shared/integrity/canonical-json.js';

import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
import { PROCESS_CLOCK } from '../../src/modules/process/application/ports.js';
import { startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';
import { runTenantSeeders } from '../support/process-fixtures.js';

const A = '0192c016-0000-7000-8000-00000000010a';
const B = '0192c016-0000-7000-8000-00000000010b';
const ORG_A = '0192c016-0000-7000-8000-0000000010a0';
const ORG_B = '0192c016-0000-7000-8000-0000000010b0';
const OBRAS = '0192c016-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c016-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c016-0000-7000-8000-0000000010b1';
const ANA = '0192c016-0000-7000-8000-0000000010c1';
const MARTA = '0192c016-0000-7000-8000-0000000010c2';
const DAVI = '0192c016-0000-7000-8000-0000000010c3';
const BETO = '0192c016-0000-7000-8000-0000000010c6';
const ANA_M = '0192c016-0000-7000-8000-0000000010d1';
const NOW = new Date('2026-10-05T15:00:00.000Z');
const MFA = ['pwd', 'otp'];
const MESSAGE = 'Demanda urgente para reposição de estoque';

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us016', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'santa-luzia-us016', 'Prefeitura de Santa Luzia LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura de Santa Luzia LEAK-B', 'PMSL', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', 'sub-ana-us016', 'ana@a.test', true, 'Cláudia Ferreira'),
  ('${MARTA}', 'sub-marta-us016', 'marta@a.test', true, 'Helena Prado'),
  ('${DAVI}', 'sub-davi-us016', 'davi@a.test', true, 'Paulo Mendes'),
  ('${BETO}', 'sub-beto-us016', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth, head_user_id, deputy_user_id) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Saúde', '${path(OBRAS)}', 0, '${MARTA}', '${DAVI}'),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Compras da Saúde', '${path(OBRAS, MANUTENCAO)}', 1, NULL, NULL),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Saúde LEAK-B', '${path(OBRAS_B)}', 0, NULL, NULL);
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c016-0000-7000-8000-0000000010d2', '${A}', '${MARTA}', 'INTERNAL', 'ACTIVE'),
  ('0192c016-0000-7000-8000-0000000010d3', '${A}', '${DAVI}', 'INTERNAL', 'ACTIVE'),
  ('0192c016-0000-7000-8000-0000000010d6', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c016-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
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

describe('Feature: Concluir o DFD e enviá-lo para aprovação sobre PostgreSQL (US-016)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: { contractingType: string; origin: string; unit: string };

  const as = (call: request.Test, subject = 'sub-ana-us016', tenant = A) =>
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

  /** Background: processo na ABERTURA com o DFD completo (2 itens, seções e cabeçalho). */
  async function background(): Promise<{ process: ProcessDto; dfd: DfdDto }> {
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
    const itemIds: string[] = [];
    for (const description of ['Luvas de procedimento', 'Seringas descartáveis']) {
      const item = await as(request(api.server).post(`/api/v1/processes/${processId}/items`)).send({
        kind: 'GOOD',
        description,
        unitOfMeasureId: catalog.unit,
      });
      expect(item.status, JSON.stringify(item.body)).toBe(201);
      itemIds.push((item.body as { data: ProcessItemDto }).data.id);
    }
    const dfdResponse = await as(
      request(api.server).post(`/api/v1/processes/${processId}/dfds`),
    ).send({});
    expect(dfdResponse.status, JSON.stringify(dfdResponse.body)).toBe(201);
    const dfd = (dfdResponse.body as { data: DfdDto }).data;
    const items = await as(request(api.server).put(`/api/v1/documents/${dfd.documentId}/items`))
      .set('If-Match', '"1"')
      .send({
        items: itemIds.map((processItemId, index) => ({
          processItemId,
          quantity: String((index + 1) * 100),
        })),
      });
    expect(items.status, JSON.stringify(items.body)).toBe(200);
    for (const [key, text] of [
      ['JUSTIFICATION', 'x'.repeat(380)],
      ['EXPECTED_RESULTS', 'Atendimento contínuo da UBS Centro.'],
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
      .send({ expectedDate: '2026-12-15', pcaStatus: 'PLANNED', pcaYear: 2026 });
    expect(header.status, JSON.stringify(header.body)).toBe(200);
    const process = await as(request(api.server).get(`/api/v1/processes/${processId}`));
    expect(process.status, JSON.stringify(process.body)).toBe(200);
    return { process: (process.body as { data: ProcessDto }).data, dfd };
  }

  const transitionOf = async (processId: string) =>
    (
      await one<{ id: string }>(
        `SELECT t.id FROM workflow_transitions t JOIN processes p ON p.workflow_version_id = t.workflow_version_id
          WHERE p.id = $1 AND t.key = 'ENVIAR_APROVACAO_DFD'`,
        [processId],
      )
    ).id;
  const forward = async (process: ProcessDto, subject?: string, tenant?: string) =>
    as(request(api.server).post(`/api/v1/processes/${process.id}/forward`), subject, tenant)
      .set('If-Match', `"${String(process.version)}"`)
      .send({
        transitionId: await transitionOf(process.id),
        expectedStageId: process.currentStage?.id,
        comment: MESSAGE,
        acknowledgedWarnings: [],
      });

  /** O que o envio grava — para provar o rollback. */
  const effects = async (processId: string) => ({
    process: await db.admin<Row>(
      'SELECT status::text, version, current_stage_id FROM processes WHERE id = $1',
      [processId],
    ),
    movements: await db.admin<Row>(
      'SELECT sequence FROM process_movements WHERE process_id = $1 ORDER BY sequence',
      [processId],
    ),
    approvals: await db.admin<Row>('SELECT id FROM approvals WHERE process_id = $1', [processId]),
    documents: await db.admin<Row>(
      'SELECT status::text, pending_approval_id, current_version_id FROM documents WHERE process_id = $1',
      [processId],
    ),
    versions: await db.admin<Row>('SELECT id FROM document_versions WHERE process_id = $1', [
      processId,
    ]),
    events: await db.admin<Row>(
      `SELECT event_type FROM outbox_events WHERE process_id = $1
          AND event_type IN ('ProcessStageChanged', 'DocumentSubmitted', 'ApprovalRequested')`,
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

  it('[Sucesso] uma transação: DFD IN_REVIEW com a versão 1 SUBMISSION (hash do JSON gravado), aprovação com a mensagem cobrindo a versão e tramitação', async () => {
    const { process, dfd } = await background();

    const response = await forward(process);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const approvalId = (response.body as { data: ForwardedProcessDto }).data.approval?.id;
    const version = await one<{
      id: string;
      version_number: number;
      reason: string;
      content: unknown;
      content_hash: string;
    }>(
      `SELECT id, version_number, reason::text, content, content_hash FROM document_versions
        WHERE document_id = $1`,
      [dfd.documentId],
    );
    expect(version).toMatchObject({ version_number: 1, reason: 'SUBMISSION' });
    expect(version.content_hash).toBe(sha256Hex(canonicalJson(version.content)));
    expect(
      await one('SELECT status::text, pending_approval_id FROM documents WHERE id = $1', [
        dfd.documentId,
      ]),
    ).toEqual({ status: 'IN_REVIEW', pending_approval_id: approvalId });
    expect(
      await one(
        `SELECT status::text, approver_user_id, allow_deputy, request_comment, title FROM approvals
          WHERE id = $1`,
        [approvalId],
      ),
    ).toEqual({
      status: 'PENDING',
      approver_user_id: MARTA,
      allow_deputy: true,
      request_comment: MESSAGE,
      title: expect.stringMatching(/^Aprovação da demanda — DFD \d{4}\/\d{4}$/) as unknown,
    });
    expect(
      await db.admin('SELECT document_version_id FROM approval_documents WHERE approval_id = $1', [
        approvalId,
      ]),
    ).toEqual([{ document_version_id: version.id }]);
    expect(
      await one(
        `SELECT action::text, comment FROM process_movements WHERE process_id = $1
          ORDER BY sequence DESC LIMIT 1`,
        [process.id],
      ),
    ).toEqual({ action: 'FORWARD', comment: MESSAGE });
  });

  it('[Falha de banco] o banco falha ao gravar a aprovação: 503 DEPENDENCY_UNAVAILABLE e o DFD continua DRAFT sem versão, o processo na ABERTURA', async () => {
    const { process } = await background();
    const before = await effects(process.id);
    const insert = vi
      .spyOn(PrismaApprovalRepository.prototype, 'insert')
      .mockRejectedValue(new DatabaseUnavailableError(new Error('ECONNRESET')));
    try {
      const failed = await forward(process);
      expect(failed.status, JSON.stringify(failed.body)).toBe(503);
      expect(problemDetailsSchema.parse(failed.body).code).toBe('DEPENDENCY_UNAVAILABLE');
    } finally {
      insert.mockRestore();
    }
    const after = await effects(process.id);
    expect(after).toEqual(before);
    expect(after.documents).toEqual([
      { status: 'DRAFT', pending_approval_id: null, current_version_id: null },
    ]);
  });

  it('[Tenant incorreto] encaminhar o processo de outro tenant: 404 PROCESS_NOT_FOUND e nada muda', async () => {
    const { process } = await background();
    const before = await effects(process.id);
    const response = await forward(process, 'sub-beto-us016', B);
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(problemDetailsSchema.parse(response.body).code).toBe('PROCESS_NOT_FOUND');
    expect(await effects(process.id)).toEqual(before);
  });
});
