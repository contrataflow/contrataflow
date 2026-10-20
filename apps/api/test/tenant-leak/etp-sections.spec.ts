// Edição das seções do ETP sobre PostgreSQL real (US-020 · Sucesso, Tenant incorreto,
// Concorrência): a API inteira como `cf_app` (RLS) com os seeders reais, o processo pelo PRC-02 (Ana)
// levado (SQL) à etapa ESTUDOS_PRELIMINARES com o Rui (PLANEJAMENTO) responsável e o ETP pelo
// ETP-02. Prova o ETP-03 com o rascunho e a revisão de cada seção, o DOC-05 gravando `FILLED` e
// `NOT_APPLICABLE` (com justificativa) no `jsonb` de `documents` sem criar versão, a auditoria
// coalescida `document.draft_update`, 10 gravações paralelas na mesma seção (exatamente uma 200)
// e o isolamento: ETP de A visto do tenant B → 404 sem alterar nada; a leitura sob o
// `app.tenant_id` de B não vê a linha. `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { etpDetailSchema, problemDetailsSchema } from '@contrataflow/validation';
import type { EtpDto, ProcessDto } from '@contrataflow/validation';
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

const A = '0192c020-0000-7000-8000-00000000010a';
const B = '0192c020-0000-7000-8000-00000000010b';
const ORG_A = '0192c020-0000-7000-8000-0000000010a0';
const ORG_B = '0192c020-0000-7000-8000-0000000010b0';
const OBRAS = '0192c020-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c020-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c020-0000-7000-8000-0000000010b1';
const ANA = '0192c020-0000-7000-8000-0000000010c1';
const RUI = '0192c020-0000-7000-8000-0000000010c2';
const BETO = '0192c020-0000-7000-8000-0000000010c3';
const ANA_M = '0192c020-0000-7000-8000-0000000010d1';
const NOW = new Date('2026-10-18T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [RUI]: ['PLANEJAMENTO'],
  [BETO]: ['PLANEJAMENTO'],
};

const SUBJECTS = { ana: 'sub-ana-us020', rui: 'sub-rui-us020', beto: 'sub-beto-us020' } as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us020', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'santa-luzia-us020', 'Prefeitura de Santa Luzia LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
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
  ('${ANA}', '${SUBJECTS.ana}', 'ana-us020@a.test', true, 'Ana Souza'),
  ('${RUI}', '${SUBJECTS.rui}', 'rui-us020@a.test', true, 'Carla Mendes'),
  ('${BETO}', '${SUBJECTS.beto}', 'beto-us020@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c020-0000-7000-8000-0000000010d2', '${A}', '${RUI}', 'INTERNAL', 'ACTIVE'),
  ('0192c020-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c020-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
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

describe('Feature: Editar seções do ETP sobre PostgreSQL (US-020)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: { contractingType: string; origin: string };

  const tenantOf = (subject: string): string => (subject === SUBJECTS.beto ? B : A);
  const call = (test: request.Test, subject: string = SUBJECTS.rui) =>
    test
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));

  /** Processo (PRC-02, Ana) nos ESTUDOS_PRELIMINARES com o Rui e o ETP criado por ele (ETP-02). */
  const newEtp = async (): Promise<EtpDto> => {
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
    await db.admin(
      `UPDATE processes p SET status = 'IN_PROGRESS', current_workflow_stage_id = ws.id,
              current_responsible_id = $2
         FROM workflow_stages ws
        WHERE p.id = $1 AND ws.workflow_version_id = p.workflow_version_id
          AND ws.key = 'ESTUDOS_PRELIMINARES'`,
      [process.id, RUI],
    );
    const created = await call(request(api.server).post(`/api/v1/processes/${process.id}/etps`))
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return (created.body as { data: EtpDto }).data;
  };
  const getEtp = (id: string, subject: string = SUBJECTS.rui) =>
    call(request(api.server).get(`/api/v1/etps/${id}`), subject);
  const detailOf = async (id: string) =>
    etpDetailSchema.parse(((await getEtp(id)).body as { data: unknown }).data);
  const putSection = (
    documentId: string,
    sectionKey: string,
    body: Record<string, unknown>,
    ifMatch: string,
    subject: string = SUBJECTS.rui,
  ) =>
    call(request(api.server).put(`/api/v1/documents/${documentId}/sections/${sectionKey}`), subject)
      .set('If-Match', ifMatch)
      .send(body);
  const documentRow = async (documentId: string) => {
    const [row] = await db.admin<Row>(
      'SELECT version, draft_revision, draft_content, status::text FROM documents WHERE id = $1',
      [documentId],
    );
    return row;
  };
  const sectionsOf = (row: Row | undefined) =>
    (row?.draft_content as { sections: Record<string, Row> }).sections;
  const draftAudits = (documentId: string) =>
    db.admin<Row>(
      `SELECT metadata->>'sectionKey' AS section_key, metadata->>'state' AS state
         FROM audit_logs WHERE entity_id = $1 AND action = 'document.draft_update'
        ORDER BY created_at, id`,
      [documentId],
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
    };
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] ETP-03 traz o rascunho; DOC-05 grava FILLED e NOT_APPLICABLE no jsonb, sem versão nova, com auditoria coalescida', async () => {
    const etp = await newEtp();
    const detail = await detailOf(etp.id);
    expect(detail.draftContent.sections.NEED_DESCRIPTION?.state).toBe('EMPTY');
    const revision = detail.draftContent.sections.NEED_DESCRIPTION?.revision ?? 0;

    const saved = await putSection(
      etp.documentId,
      'NEED_DESCRIPTION',
      {
        content: paragraph('Os prédios das escolas apresentam infiltrações.'),
        notApplicable: false,
      },
      `"s${String(revision)}"`,
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.headers.etag).toBe(`"s${String(revision + 1)}"`);
    const notApplicable = await putSection(
      etp.documentId,
      'MARKET_SURVEY',
      {
        content: null,
        state: 'NOT_APPLICABLE',
        justification: 'Solução única no mercado nacional.',
      },
      `"s${String(detail.draftContent.sections.MARKET_SURVEY?.revision ?? 0)}"`,
    );
    expect(notApplicable.status, JSON.stringify(notApplicable.body)).toBe(200);

    const row = await documentRow(etp.documentId);
    expect(sectionsOf(row).NEED_DESCRIPTION).toMatchObject({
      state: 'FILLED',
      revision: revision + 1,
    });
    expect(sectionsOf(row).MARKET_SURVEY).toMatchObject({
      state: 'NOT_APPLICABLE',
      content: null,
      justification: 'Solução única no mercado nacional.',
    });
    expect(row?.version).toBe(etp.documentVersion);
    const [versions] = await db.admin<{ count: number }>(
      'SELECT count(*)::int AS count FROM document_versions WHERE document_id = $1',
      [etp.documentId],
    );
    expect(versions?.count).toBe(0);
    expect(await draftAudits(etp.documentId)).toEqual([
      { section_key: 'NEED_DESCRIPTION', state: 'FILLED' },
      { section_key: 'MARKET_SURVEY', state: 'NOT_APPLICABLE' },
    ]);
    const reread = await detailOf(etp.id);
    expect(reread.draftContent.sections.NEED_DESCRIPTION?.revision).toBe(revision + 1);
    expect(reread.draftRevision).toBe(Number(row?.draft_revision));
  });

  it('[Concorrência] 10 gravações simultâneas na mesma seção com a mesma revisão: exatamente uma 200, as demais 412', async () => {
    const etp = await newEtp();
    const revision = (await detailOf(etp.id)).draftContent.sections.OBJECTIVE?.revision ?? 0;
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        putSection(
          etp.documentId,
          'OBJECTIVE',
          {
            content: paragraph(`Objetivo redigido na aba ${String(index)}.`),
            notApplicable: false,
          },
          `"s${String(revision)}"`,
        ),
      ),
    );
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 412)).toHaveLength(9);
    for (const response of responses.filter((candidate) => candidate.status === 412)) {
      expect(problemDetailsSchema.parse(response.body).code).toBe('SECTION_REVISION_CONFLICT');
    }
    expect(sectionsOf(await documentRow(etp.documentId)).OBJECTIVE).toMatchObject({
      state: 'FILLED',
      revision: revision + 1,
    });
  });

  it('[Tenant incorreto] ETP de A visto do tenant B: ETP-03 e DOC-05 → 404 NOT_FOUND sem alterar nada; a RLS de B não vê a linha', async () => {
    const etp = await newEtp();
    const before = await documentRow(etp.documentId);

    const read = await getEtp(etp.id, SUBJECTS.beto);
    expect(read.status, JSON.stringify(read.body)).toBe(404);
    expect(problemDetailsSchema.parse(read.body).code).toBe('NOT_FOUND');
    expect(JSON.stringify(read.body)).not.toContain(etp.code ?? '#');
    const write = await putSection(
      etp.documentId,
      'NEED_DESCRIPTION',
      { content: paragraph('Tentativa da Prefeitura de Santa Luzia'), notApplicable: false },
      '"s1"',
      SUBJECTS.beto,
    );
    expect(write.status, JSON.stringify(write.body)).toBe(404);
    expect(problemDetailsSchema.parse(write.body).code).toBe('NOT_FOUND');
    expect(await documentRow(etp.documentId)).toEqual(before);
    expect(await draftAudits(etp.documentId)).toEqual([]);

    const client = db.client('cf_app');
    try {
      const visible = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$queryRaw<{ count: number }[]>`
            SELECT (SELECT count(*)::int FROM etps WHERE id = ${etp.id}::uuid)
                 + (SELECT count(*)::int FROM documents WHERE id = ${etp.documentId}::uuid) AS count`,
        ),
      );
      expect(visible).toEqual([{ count: 0 }]);
    } finally {
      await client.$disconnect();
    }
  });
});
