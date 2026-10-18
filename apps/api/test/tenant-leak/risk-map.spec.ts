// Matriz e Mapa de Riscos sobre PostgreSQL real (US-035 · Sucesso, Tenant incorreto, Duplicidade,
// Falha de integração): a API inteira como `cf_app` (RLS) com os seeders reais (inclusive a
// biblioteca de templates — US-110), o processo criado pelo PRC-02 na etapa "ETP e mapa de riscos"
// e os riscos pelo RSK-02. Prova a matriz (RSK-09) lida sob RLS, a emissão (RSK-10) com o índice
// único parcial do singleton (`documents_singleton_key` — duas emissões simultâneas: uma 201 e
// uma 409), a finalização (DOC-10) com o snapshot dos riscos e tratamentos na `document_versions`
// (RN-RISK-20), o bloqueio dos riscos (RN-RISK-23), os eventos `PENDING` e a RLS (processo e
// documento de outro tenant). `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { DocumentDto, ProcessDto, RiskDto, RiskMatrixDto } from '@contrataflow/validation';
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
import { PROCESS_PREREQUISITE_SEEDERS, runTenantSeeders } from '../support/process-fixtures.js';

const A = '0192c035-0000-7000-8000-00000000010a';
const B = '0192c035-0000-7000-8000-00000000010b';
const ORG_A = '0192c035-0000-7000-8000-0000000010a0';
const ORG_B = '0192c035-0000-7000-8000-0000000010b0';
const OBRAS = '0192c035-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c035-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c035-0000-7000-8000-0000000010b1';
const ANA = '0192c035-0000-7000-8000-0000000010c1';
const BETO = '0192c035-0000-7000-8000-0000000010c3';
const ANA_M = '0192c035-0000-7000-8000-0000000010d1';
const NOW = new Date('2026-10-18T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const SUBJECTS = { ana: 'sub-ana-us035', beto: 'sub-beto-us035' } as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us035', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us035', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
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
  ('${BETO}', '${SUBJECTS.beto}', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c035-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c035-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
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
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe('Feature: Matriz e Mapa de Riscos sobre PostgreSQL (US-035)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: { contractingType: string; origin: string; market: string };

  const tenantOf = (subject: string): string => (subject === SUBJECTS.beto ? B : A);
  const call = (test: request.Test, subject: string = SUBJECTS.ana) =>
    test
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));

  /** Processo pelo PRC-02 (Ana responsável) em andamento na etapa do mapa de riscos. */
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
  const addRisk = async (processId: string, probability: number, impact: number) => {
    const response = await call(request(api.server).post(`/api/v1/processes/${processId}/risks`))
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Risco ${words(1)}`,
        categoryId: catalog.market,
        phase: 'PLANNING',
        cause: 'Mercado local com poucos fornecedores habilitados',
        consequence: 'Licitação deserta e atraso na contratação',
        probability,
        impact,
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return (response.body as { data: RiskDto }).data;
  };
  const emit = (processId: string, subject?: string) =>
    call(request(api.server).post(`/api/v1/processes/${processId}/risk-map`), subject)
      .set('Idempotency-Key', randomUUID())
      .send({});
  const matrix = (processId: string, subject?: string) =>
    call(request(api.server).get(`/api/v1/processes/${processId}/risk-matrix`), subject);
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
    const seeders = [...PROCESS_PREREQUISITE_SEEDERS, 'document.templateLibrary'];
    await runTenantSeeders(api, A, seeders);
    await runTenantSeeders(api, B, seeders);
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

  it('[Sucesso] matriz, emissão e finalização: snapshot na document_versions, riscos bloqueados e eventos PENDING', async () => {
    const process = await createProcess();
    const r01 = await addRisk(process.id, 2, 2);
    await addRisk(process.id, 1, 1);

    const grid = await matrix(process.id);
    expect(grid.status, JSON.stringify(grid.body)).toBe(200);
    const occupied = (grid.body as { data: RiskMatrixDto }).data.cells.filter(
      (cell) => cell.risks.length > 0,
    );
    expect(occupied.map((cell) => [cell.probability, cell.impact, cell.risks[0]?.code])).toEqual([
      [2, 2, 'R01'],
      [1, 1, 'R02'],
    ]);

    const emitted = await emit(process.id);
    expect(emitted.status, JSON.stringify(emitted.body)).toBe(201);
    const document = (emitted.body as { data: DocumentDto }).data;
    for (const key of ['INTRODUCTION', 'METHODOLOGY']) {
      const saved = await call(
        request(api.server).put(`/api/v1/documents/${document.id}/sections/${key}`),
      )
        .set('If-Match', '"s1"')
        .send({
          content: paragraph(`Texto da seção ${key} do mapa de riscos.`),
          notApplicable: false,
          justification: null,
        });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    }
    const finalized = await call(
      request(api.server).post(`/api/v1/documents/${document.id}/finalize`),
    )
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(finalized.status, JSON.stringify(finalized.body)).toBe(200);
    expect((finalized.body as { data: DocumentDto }).data.status).toBe('FINALIZED');

    const versions = await db.admin<Row>(
      `SELECT reason::text, content->'header'->>'riskCount' AS "riskCount",
              jsonb_array_length(content->'collections'->'risks') AS risks, content_hash
         FROM document_versions WHERE document_id = $1`,
      [document.id],
    );
    expect(versions).toEqual([
      expect.objectContaining({ reason: 'FINALIZATION', riskCount: '2', risks: 2 }),
    ]);
    const events = await db.admin<Row>(
      `SELECT routing_key, status::text FROM outbox_events
        WHERE aggregate_id = $1 ORDER BY occurred_at, id`,
      [document.id],
    );
    expect(events).toEqual([
      { routing_key: 'document.created.risk_map', status: 'PENDING' },
      { routing_key: 'document.version_created.risk_map', status: 'PENDING' },
      { routing_key: 'document.finalized.risk_map', status: 'PENDING' },
    ]);
    const audit = await db.admin<Row>(
      "SELECT metadata->'typedSummary'->>'riskCount' AS count FROM audit_logs WHERE entity_id = $1 AND action = 'document.finalize'",
      [document.id],
    );
    expect(audit).toEqual([{ count: '2' }]);

    // RN-RISK-23: o mapa concluído trava os riscos (o RISK_MAP é travado no `tx`).
    const locked = await call(request(api.server).patch(`/api/v1/risks/${r01.id}`))
      .set('If-Match', '"1"')
      .send({ title: 'Risco revisado' });
    expect(locked.status).toBe(409);
    expect(problemDetailsSchema.parse(locked.body).code).toBe('DOCUMENT_NOT_EDITABLE');
  });

  it('[Duplicidade] duas emissões simultâneas: uma 201 e uma 409 DOCUMENT_ALREADY_EXISTS (índice único)', async () => {
    const process = await createProcess();
    await addRisk(process.id, 3, 3);
    const responses = await Promise.all([emit(process.id), emit(process.id)]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const loser = responses.find((response) => response.status === 409);
    expect(problemDetailsSchema.parse(loser?.body).code).toBe('DOCUMENT_ALREADY_EXISTS');
    const rows = await db.admin<Row>(
      'SELECT status::text FROM documents WHERE process_id = $1 AND deleted_at IS NULL',
      [process.id],
    );
    expect(rows).toEqual([{ status: 'DRAFT' }]);
  });

  it('[Tenant incorreto] RSK-09/RSK-10 com processo de A no tenant B: 404 e nada revelado; RLS dos documentos', async () => {
    const process = await createProcess();
    await addRisk(process.id, 4, 4);
    const emitted = await emit(process.id);
    expect(emitted.status, JSON.stringify(emitted.body)).toBe(201);
    const document = (emitted.body as { data: DocumentDto }).data;

    for (const response of [
      await matrix(process.id, SUBJECTS.beto),
      await emit(process.id, SUBJECTS.beto),
    ]) {
      expect(response.status).toBe(404);
      expect(problemDetailsSchema.parse(response.body).code).toBe('NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain('R01');
    }
    expect(
      await db.admin<Row>('SELECT count(*)::int AS count FROM documents WHERE process_id = $1', [
        process.id,
      ]),
    ).toEqual([{ count: 1 }]);

    // RLS: com `app.tenant_id` de B, nem o documento nem os riscos de A são visíveis.
    const client = db.client('cf_app');
    try {
      const visible = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$queryRaw<{ documents: number; risks: number }[]>`
            SELECT (SELECT count(*)::int FROM documents WHERE id = ${document.id}::uuid) AS documents,
                   (SELECT count(*)::int FROM risks WHERE process_id = ${process.id}::uuid) AS risks`,
        ),
      );
      expect(visible).toEqual([{ documents: 0, risks: 0 }]);
    } finally {
      await client.$disconnect();
    }
  });
});
