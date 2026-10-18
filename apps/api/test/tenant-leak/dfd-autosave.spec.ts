// Autosave do DFD sobre PostgreSQL real (US-015 · Sucesso, Tenant incorreto, Concorrência): a API
// inteira como `cf_app` (RLS) com os seeders reais, o processo pelo PRC-02 e o DFD pelo DFD-02. Prova
// a atualização condicional atômica do DOC-05 (`jsonb_set` + revisão da seção + status no mesmo
// `UPDATE`) — 50 gravações paralelas na mesma seção: exatamente uma por revisão —, seções
// diferentes sem conflito, `Document.version` intacta e nenhuma `document_versions` (RN-DFD-24/26),
// a auditoria `document.draft_update`, o DFD-04 com os CHECKs de `dfds` e o isolamento: documento e
// DFD de A vistos do tenant B → 404 sem alterar nada; a própria atualização condicional sob o
// `app.tenant_id` de B não toca a linha. `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { DfdDto, DraftSection, ProcessDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
import { DFD_CLOCK } from '../../src/modules/dfd/application/ports.js';
import { PrismaDocumentRepository } from '../../src/modules/document/infrastructure/prisma-document.repository.js';
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

const A = '0192c015-0000-7000-8000-00000000010a';
const B = '0192c015-0000-7000-8000-00000000010b';
const ORG_A = '0192c015-0000-7000-8000-0000000010a0';
const ORG_B = '0192c015-0000-7000-8000-0000000010b0';
const OBRAS = '0192c015-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c015-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c015-0000-7000-8000-0000000010b1';
const ANA = '0192c015-0000-7000-8000-0000000010c1';
const BETO = '0192c015-0000-7000-8000-0000000010c3';
const ANA_M = '0192c015-0000-7000-8000-0000000010d1';
const NOW = new Date('2026-10-17T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const SUBJECTS = { ana: 'sub-ana-us015', beto: 'sub-beto-us015' } as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us015', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'santa-luzia-us015', 'Prefeitura de Santa Luzia LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura de Santa Luzia LEAK-B', 'PMSL', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Saúde', '${path(OBRAS)}', 0),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Atenção Básica', '${path(OBRAS, MANUTENCAO)}', 1),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Saúde LEAK-B', '${path(OBRAS_B)}', 0);
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', '${SUBJECTS.ana}', 'claudia-us015@a.test', true, 'Cláudia Ferreira'),
  ('${BETO}', '${SUBJECTS.beto}', 'beto-us015@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c015-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c015-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
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

describe('Feature: Autosave do DFD sobre PostgreSQL (US-015)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: { contractingType: string; origin: string };

  const tenantOf = (subject: string): string => (subject === SUBJECTS.beto ? B : A);
  const call = (test: request.Test, subject: string = SUBJECTS.ana) =>
    test
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));

  const putSection = (
    documentId: string,
    sectionKey: string,
    text: string,
    ifMatch: string,
    subject: string = SUBJECTS.ana,
  ) =>
    call(request(api.server).put(`/api/v1/documents/${documentId}/sections/${sectionKey}`), subject)
      .set('If-Match', ifMatch)
      .send({ content: paragraph(text), notApplicable: false, justification: null });
  const patchDfd = (
    dfdId: string,
    body: Record<string, unknown>,
    ifMatch: string,
    subject: string = SUBJECTS.ana,
  ) =>
    call(request(api.server).patch(`/api/v1/dfds/${dfdId}`), subject)
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

  /** O documento como está no banco (seções, revisões e versão). */
  const documentRow = async (documentId: string) => {
    const [row] = await db.admin<{
      draft_content: { sections: Record<string, DraftSection> };
      draft_revision: number;
      version: number;
      versions: number;
    }>(
      `SELECT draft_content, draft_revision, version,
              (SELECT count(*) FROM document_versions v WHERE v.document_id = d.id)::int AS versions
         FROM documents d WHERE id = $1`,
      [documentId],
    );
    if (!row) throw new Error('documento ausente');
    return row;
  };
  const draftAudits = (documentId: string) =>
    db.admin<Row>(
      "SELECT metadata, tenant_id FROM audit_logs WHERE entity_id = $1 AND action = 'document.draft_update' ORDER BY occurred_at, id",
      [documentId],
    );

  /** Processo pelo PRC-02 e DFD pelo DFD-02 (Ana responsável). */
  const newDfd = async (): Promise<DfdDto> => {
    const process = await call(request(api.server).post('/api/v1/processes'))
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Aquisição de insumos ${words(2)}`,
        object: `Aquisição de insumos para a UBS Centro ${words(2)}`,
        contractingTypeId: catalog.contractingType,
        requestingSecretariatId: OBRAS,
        requestingDepartmentId: MANUTENCAO,
        originId: catalog.origin,
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(process.status, JSON.stringify(process.body)).toBe(201);
    const created = await call(
      request(api.server).post(
        `/api/v1/processes/${(process.body as { data: ProcessDto }).data.id}/dfds`,
      ),
    )
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return (created.body as { data: DfdDto }).data;
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
        { token: DFD_CLOCK, value: () => NOW },
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

  it('[Sucesso] DOC-05: só a seção muda (jsonb_set), revisão e draftRevision + 1, version intacta, nenhuma versão e auditoria do tenant', async () => {
    const dfd = await newDfd();
    const before = await documentRow(dfd.documentId);
    const response = await putSection(
      dfd.documentId,
      'JUSTIFICATION',
      'A UBS Centro atende 12 mil pessoas e precisa repor os insumos.',
      '"s1"',
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.headers.etag).toBe('"s2"');

    const after = await documentRow(dfd.documentId);
    expect(after.version).toBe(before.version);
    expect(after.versions).toBe(0);
    expect(after.draft_revision).toBe(before.draft_revision + 1);
    expect(after.draft_content.sections.JUSTIFICATION).toMatchObject({
      state: 'FILLED',
      revision: 2,
      updatedById: ANA,
    });
    // As demais seções ficam exatamente como estavam.
    expect(after.draft_content.sections.EXPECTED_RESULTS).toEqual(
      before.draft_content.sections.EXPECTED_RESULTS,
    );
    const audits = await draftAudits(dfd.documentId);
    expect(audits).toEqual([
      {
        tenant_id: A,
        metadata: expect.objectContaining({ fromRevision: 2, toRevision: 2 }) as unknown,
      },
    ]);
    expect(JSON.stringify(audits)).not.toContain('12 mil pessoas');
  });

  it('[Concorrência] 50 gravações paralelas na mesma seção: exatamente uma por revisão, 49 × 412', async () => {
    const dfd = await newDfd();
    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        putSection(dfd.documentId, 'JUSTIFICATION', `Texto concorrente ${String(index)}`, '"s1"'),
      ),
    );
    const ok = responses.filter((response) => response.status === 200);
    expect(ok).toHaveLength(1);
    const conflicts = responses.filter((response) => response.status === 412);
    expect(conflicts).toHaveLength(49);
    for (const conflict of conflicts) {
      expect(problemDetailsSchema.parse(conflict.body).code).toBe('SECTION_REVISION_CONFLICT');
    }
    const after = await documentRow(dfd.documentId);
    expect(after.draft_content.sections.JUSTIFICATION?.revision).toBe(2);
    expect(after.version).toBe(1);
  });

  it('[Concorrência] seções diferentes ao mesmo tempo nunca conflitam', async () => {
    const dfd = await newDfd();
    const [justification, results] = await Promise.all([
      putSection(dfd.documentId, 'JUSTIFICATION', 'Justificativa gravada em paralelo', '"s1"'),
      putSection(dfd.documentId, 'EXPECTED_RESULTS', 'Resultados gravados em paralelo', '"s1"'),
    ]);
    expect(justification.status, JSON.stringify(justification.body)).toBe(200);
    expect(results.status, JSON.stringify(results.body)).toBe(200);
    const after = await documentRow(dfd.documentId);
    expect(after.draft_content.sections.JUSTIFICATION?.revision).toBe(2);
    expect(after.draft_content.sections.EXPECTED_RESULTS?.revision).toBe(2);
  });

  it('[Sucesso] DFD-04 grava o cabeçalho com version + 1 respeitando os CHECKs; If-Match antigo → 412', async () => {
    const dfd = await newDfd();
    const saved = await patchDfd(
      dfd.id,
      {
        priority: 'HIGH',
        expectedDate: '2026-12-01',
        pcaStatus: 'NOT_PLANNED',
        pcaJustification: 'Demanda emergencial surgida após a aprovação do plano anual.',
        wizardStep: 'PLANNING',
      },
      '"1"',
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.headers.etag).toBe('"2"');
    const [row] = await db.admin<Row>(
      'SELECT priority::text, expected_date::text, pca_status::text, wizard_step::text, version FROM dfds WHERE id = $1',
      [dfd.id],
    );
    expect(row).toEqual({
      priority: 'HIGH',
      expected_date: '2026-12-01',
      pca_status: 'NOT_PLANNED',
      wizard_step: 'PLANNING',
      version: 2,
    });
    const stale = await patchDfd(dfd.id, { priority: 'LOW' }, '"1"');
    expect(stale.status).toBe(412);
    expect(problemDetailsSchema.parse(stale.body).code).toBe('VERSION_CONFLICT');
  });

  it('[Tenant incorreto] documento e DFD de A vistos do tenant B → 404 sem alterar nada; a atualização condicional sob a RLS de B não toca a linha', async () => {
    const dfd = await newDfd();
    const before = await documentRow(dfd.documentId);
    const section = await putSection(
      dfd.documentId,
      'JUSTIFICATION',
      'Tentativa da Prefeitura de Santa Luzia',
      '"s1"',
      SUBJECTS.beto,
    );
    expect(section.status, JSON.stringify(section.body)).toBe(404);
    expect(problemDetailsSchema.parse(section.body).code).toBe('NOT_FOUND');
    const header = await patchDfd(dfd.id, { priority: 'LOW' }, '"1"', SUBJECTS.beto);
    expect(header.status, JSON.stringify(header.body)).toBe(404);
    expect(problemDetailsSchema.parse(header.body).code).toBe('DFD_NOT_FOUND');

    const client = db.client('cf_app');
    try {
      const repository = new PrismaDocumentRepository();
      const written = await asTenant(B, () =>
        client.$tenantTransaction((tx) =>
          repository.saveSectionDraft(tx, {
            documentId: dfd.documentId,
            sectionKey: 'JUSTIFICATION',
            section: {
              state: 'FILLED',
              content: paragraph('Alterado por LEAK-B'),
              justification: null,
              revision: 2,
              updatedAt: NOW.toISOString(),
              updatedById: BETO,
            },
            expectedRevision: 1,
            actorId: BETO,
            now: NOW,
          }),
        ),
      );
      expect(written).toBeNull();
    } finally {
      await client.$disconnect();
    }
    expect(await documentRow(dfd.documentId)).toEqual(before);
    const [dfdRow] = await db.admin<Row>('SELECT priority::text, version FROM dfds WHERE id = $1', [
      dfd.id,
    ]);
    expect(dfdRow).toEqual({ priority: 'MEDIUM', version: 1 });
    expect(await draftAudits(dfd.documentId)).toEqual([]);
  });
});
