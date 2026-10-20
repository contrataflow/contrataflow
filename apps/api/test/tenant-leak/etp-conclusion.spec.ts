// Conclusão do ETP sobre PostgreSQL real (US-023 · Sucesso, Validação FA-03, Tenant incorreto,
// Concorrência, Falha de integração): a API inteira como `cf_app` (RLS) com os seeders reais, o
// processo pelo PRC-02 (Ana), o ETP pelo ETP-02 (Rui) com itens (DOC-07), seções preenchidas,
// alternativa recomendada (ETP-06/09), valor estimado e parcelamento (ETP-04). Prova a conclusão e o
// parcelamento gravados em `etps` (versão + 1, `document.draft_update`), o DOC-08 com as pendências
// do `EtpDocumentValidator`, o DOC-10 revalidando na MESMA transação (FA-03: a alternativa
// descartada entre a consulta e o clique bloqueia com `DOCUMENT_INCOMPLETE`, sem versão), a versão
// `FINALIZATION` com o snapshot (cabeçalho, itens, alternativas) e o `content_hash` correto, o
// `DocumentFinalized` PENDING no outbox (sem relay), o ETP de A invisível ao tenant B (404) e duas
// finalizações paralelas com o mesmo `If-Match` (exatamente um 200, o outro 412).
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import {
  documentSnapshotSchema,
  etpAlternativeSchema,
  problemDetailsSchema,
} from '@contrataflow/validation';
import type { DocumentDto, EtpDto, ProcessDto, ProcessItemDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
import { snapshotHash } from '../../src/modules/document/domain/document-snapshot.js';
import { ETP_CLOCK } from '../../src/modules/etp/application/ports.js';
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

const A = '0192c023-0000-7000-8000-00000000010a';
const B = '0192c023-0000-7000-8000-00000000010b';
const ORG_A = '0192c023-0000-7000-8000-0000000010a0';
const ORG_B = '0192c023-0000-7000-8000-0000000010b0';
const OBRAS = '0192c023-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c023-0000-7000-8000-0000000010a2';
const ANA = '0192c023-0000-7000-8000-0000000010c1';
const RUI = '0192c023-0000-7000-8000-0000000010c2';
const BETO = '0192c023-0000-7000-8000-0000000010c3';
const ANA_M = '0192c023-0000-7000-8000-0000000010d1';
const NOW = new Date('2026-10-20T15:00:00.000Z');
const MFA = ['pwd', 'otp'];
const SECTION_TEXT =
  'Texto do estudo técnico preliminar elaborado pela equipe de planejamento, com fundamentação suficiente para a seção, conforme o art. 18 da Lei 14.133/2021, sem lacunas pendentes.';

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [RUI]: ['PLANEJAMENTO'],
  [BETO]: ['PLANEJAMENTO'],
};

const SUBJECTS = { ana: 'sub-ana-us023', rui: 'sub-rui-us023', beto: 'sub-beto-us023' } as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us023', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'santa-luzia-us023', 'Prefeitura de Santa Luzia LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura de Santa Luzia LEAK-B', 'PMSL', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1);
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', '${SUBJECTS.ana}', 'ana-us023@a.test', true, 'Ana Souza'),
  ('${RUI}', '${SUBJECTS.rui}', 'rui-us023@a.test', true, 'Rui Costa'),
  ('${BETO}', '${SUBJECTS.beto}', 'beto-us023@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c023-0000-7000-8000-0000000010d2', '${A}', '${RUI}', 'INTERNAL', 'ACTIVE'),
  ('0192c023-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c023-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
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

const VIOLATIONS = z.object({
  data: z.object({ violations: z.array(z.looseObject({ code: z.string() })) }),
});

describe('Feature: Validar completude do ETP e concluí-lo sobre PostgreSQL (US-023)', () => {
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
  const patchEtp = (
    etpId: string,
    body: Record<string, unknown>,
    ifMatch: number,
    subject?: string,
  ) =>
    call(request(api.server).patch(`/api/v1/etps/${etpId}`), subject)
      .set('If-Match', `"${String(ifMatch)}"`)
      .send(body);
  const etpVersion = async (etpId: string) => {
    const [row] = await db.admin<{ version: number }>('SELECT version FROM etps WHERE id = $1', [
      etpId,
    ]);
    return row?.version ?? 0;
  };
  const documentVersion = async (documentId: string) => {
    const [row] = await db.admin<{ version: number }>(
      'SELECT version FROM documents WHERE id = $1',
      [documentId],
    );
    return row?.version ?? 0;
  };
  const finalize = (
    documentId: string,
    ifMatch: number,
    options: { subject?: string; key?: string } = {},
  ) =>
    call(request(api.server).post(`/api/v1/documents/${documentId}/finalize`), options.subject)
      .set('If-Match', `"${String(ifMatch)}"`)
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send({});
  const violationsOf = async (documentId: string) => {
    const response = await call(
      request(api.server).get(`/api/v1/documents/${documentId}/validation`),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return VIOLATIONS.parse(response.body).data.violations.map((item) => item.code);
  };
  const count = async (sql: string, params: unknown[]) => {
    const [row] = await db.admin<{ count: string }>(sql, params);
    return Number(row?.count ?? 0);
  };
  const catalogId = async (tenantId: string, type: string, code: string) => {
    const [row] = await db.admin<{ id: string }>(
      'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
      [tenantId, type, code],
    );
    if (!row) throw new Error(`${type}/${code} ausente`);
    return row.id;
  };

  /**
   * Background: processo (PRC-02, Ana) com 2 itens; ETP (ETP-02, Rui) nos estudos preliminares com
   * os 2 itens com quantidade, todas as seções preenchidas, uma alternativa recomendada, valor
   * estimado R$ 125.000,00, parcelamento e conclusão VIABLE.
   */
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
    await moveTo(process.id, 'ESTUDOS_PRELIMINARES');
    const etpResponse = await call(request(api.server).post(`/api/v1/processes/${process.id}/etps`))
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(etpResponse.status, JSON.stringify(etpResponse.body)).toBe(201);
    const etp = (etpResponse.body as { data: EtpDto }).data;
    const seeded = await call(request(api.server).put(`/api/v1/documents/${etp.documentId}/items`))
      .set('If-Match', `"${String(etp.documentVersion)}"`)
      .send({ items: items.map((item) => ({ processItemId: item.id, quantity: '400' })) });
    expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);

    // Seções do template preenchidas (o trabalho da US-020), direto no rascunho.
    await db.admin(
      `UPDATE documents d
          SET draft_content = jsonb_build_object('sections', (
            SELECT jsonb_object_agg(s ->> 'key', jsonb_build_object(
              'state', 'FILLED',
              'content', jsonb_build_object('type', 'doc', 'content', jsonb_build_array(
                jsonb_build_object('type', 'paragraph', 'content', jsonb_build_array(
                  jsonb_build_object('type', 'text', 'text', (s ->> 'title') || '. ' || $2))))),
              'justification', NULL, 'revision', 1, 'updatedAt', $3::text, 'updatedById', $4::text))
              FROM document_template_versions v, jsonb_array_elements(v.sections) s
             WHERE v.id = d.template_version_id))
        WHERE d.id = $1`,
      [etp.documentId, SECTION_TEXT, NOW.toISOString(), RUI],
    );

    const created = await call(request(api.server).post(`/api/v1/etps/${etp.id}/alternatives`))
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'Aquisição direta', description: paragraph('Compra dos materiais') });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const alternative = etpAlternativeSchema.parse((created.body as { data: unknown }).data);
    const decided = await call(
      request(api.server).post(`/api/v1/etp-alternatives/${alternative.id}/decide`),
    )
      .set('If-Match', `"${String(alternative.version)}"`)
      .send({
        decision: 'RECOMMENDED',
        decisionJustification: 'Menor custo total e prazo compatível com a obra.',
      });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);

    const header = await patchEtp(
      etp.id,
      {
        estimatedValueSource: 'MANUAL',
        estimatedTotalValue: '125000.00',
        parcelingDecision: 'NOT_PARCELED',
        conclusion: 'VIABLE',
      },
      await etpVersion(etp.id),
    );
    expect(header.status, JSON.stringify(header.body)).toBe(200);
    return {
      process,
      etp,
      alternative: etpAlternativeSchema.parse((decided.body as { data: unknown }).data),
    };
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
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] ETP-04 grava conclusão/parcelamento; DOC-10 cria a versão FINALIZATION com snapshot e hash e deixa o DocumentFinalized PENDING', async () => {
    const { etp } = await background();
    const [row] = await db.admin<Row>(
      'SELECT conclusion::text, parceling_decision::text FROM etps WHERE id = $1',
      [etp.id],
    );
    expect(row).toEqual({ conclusion: 'VIABLE', parceling_decision: 'NOT_PARCELED' });
    const [audit] = await db.admin<{ changes: unknown }>(
      `SELECT changes FROM audit_logs WHERE entity_id = $1 AND action = 'document.draft_update'
        ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      [etp.documentId],
    );
    expect(audit?.changes).toEqual(
      expect.arrayContaining([
        { path: 'conclusion', old: 'PENDING', new: 'VIABLE' },
        { path: 'parcelingDecision', old: null, new: 'NOT_PARCELED' },
      ]),
    );
    expect(await violationsOf(etp.documentId)).toEqual([]);

    const response = await finalize(etp.documentId, await documentVersion(etp.documentId));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const document = (response.body as { data: DocumentDto }).data;
    expect(document.status).toBe('FINALIZED');

    const [version] = await db.admin<{ reason: string; content: unknown; content_hash: string }>(
      'SELECT reason::text, content, content_hash FROM document_versions WHERE document_id = $1',
      [etp.documentId],
    );
    expect(version?.reason).toBe('FINALIZATION');
    const snapshot = documentSnapshotSchema.parse(version?.content);
    expect(snapshot.header).toMatchObject({
      conclusion: 'VIABLE',
      parcelingDecision: 'NOT_PARCELED',
      estimatedTotalValue: '125000.00',
    });
    expect(snapshot.collections.items).toHaveLength(2);
    expect(snapshot.collections.alternatives).toEqual([
      expect.objectContaining({ decision: 'RECOMMENDED' }),
    ]);
    expect(version?.content_hash).toBe(snapshotHash(snapshot));

    // Falha de integração: sem relay, o evento fica PENDING no outbox.
    const events = await db.admin<{ event_type: string; routing_key: string; status: string }>(
      `SELECT event_type, routing_key, status::text FROM outbox_events
        WHERE aggregate_id = $1 AND event_type IN ('DocumentFinalized', 'DocumentVersionCreated')
        ORDER BY event_type DESC`,
      [etp.documentId],
    );
    expect(events).toEqual([
      {
        event_type: 'DocumentVersionCreated',
        routing_key: 'document.version_created.etp',
        status: 'PENDING',
      },
      { event_type: 'DocumentFinalized', routing_key: 'document.finalized.etp', status: 'PENDING' },
    ]);
    expect(
      await count(
        `SELECT count(*) FROM audit_logs WHERE entity_id = $1 AND action = 'document.finalize'`,
        [etp.documentId],
      ),
    ).toBe(1);
  });

  it('[Validação] FA-03: a alternativa descartada entre a consulta e o clique bloqueia a finalização (revalidação na transação)', async () => {
    const { etp, alternative } = await background();
    expect(await violationsOf(etp.documentId)).toEqual([]);
    const discarded = await call(
      request(api.server).post(`/api/v1/etp-alternatives/${alternative.id}/decide`),
    )
      .set('If-Match', `"${String(alternative.version)}"`)
      .send({
        decision: 'DISCARDED',
        decisionJustification: 'Fornecedor único deixou de atender a região.',
      });
    expect(discarded.status, JSON.stringify(discarded.body)).toBe(200);
    const response = await finalize(etp.documentId, await documentVersion(etp.documentId));
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    const problem = problemDetailsSchema.parse(response.body);
    expect(problem.code).toBe('DOCUMENT_INCOMPLETE');
    expect(problem.violations.map((item) => item.code)).toContain(
      'ETP_RECOMMENDED_ALTERNATIVE_REQUIRED',
    );
    const [row] = await db.admin<{ status: string }>(
      'SELECT status::text FROM documents WHERE id = $1',
      [etp.documentId],
    );
    expect(row?.status).toBe('DRAFT');
    expect(
      await count('SELECT count(*) FROM document_versions WHERE document_id = $1', [
        etp.documentId,
      ]),
    ).toBe(0);
  });

  it('[Tenant incorreto] ETP de A invisível ao tenant B: DOC-10 e ETP-04 → 404 sem alterar nada', async () => {
    const { etp } = await background();
    const version = await documentVersion(etp.documentId);
    const finalized = await finalize(etp.documentId, version, { subject: SUBJECTS.beto });
    expect(finalized.status, JSON.stringify(finalized.body)).toBe(404);
    expect(problemDetailsSchema.parse(finalized.body).code).toBe('NOT_FOUND');
    const patched = await patchEtp(
      etp.id,
      { conclusion: 'NOT_VIABLE' },
      await etpVersion(etp.id),
      SUBJECTS.beto,
    );
    expect(patched.status, JSON.stringify(patched.body)).toBe(404);
    const [row] = await db.admin<Row>(
      `SELECT d.status::text AS status, e.conclusion::text AS conclusion
         FROM documents d JOIN etps e ON e.id = d.id WHERE d.id = $1`,
      [etp.documentId],
    );
    expect(row).toEqual({ status: 'DRAFT', conclusion: 'VIABLE' });
  });

  it('[Concorrência] duas finalizações paralelas com o mesmo If-Match: exatamente um 200 e um 412', async () => {
    const { process, etp } = await background();
    await db.admin(
      `INSERT INTO process_participants (id, tenant_id, process_id, user_id, role, granted_by_id)
       VALUES ($1, $2, $3, $4, 'COLLABORATOR', $5)`,
      [randomUUID(), A, process.id, ANA, RUI],
    );
    const version = await documentVersion(etp.documentId);
    const [one, two] = await Promise.all([
      finalize(etp.documentId, version),
      finalize(etp.documentId, version, { subject: SUBJECTS.ana }),
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 412]);
    const loser = one.status === 412 ? one : two;
    expect(problemDetailsSchema.parse(loser.body).code).toBe('VERSION_CONFLICT');
    expect(
      await count('SELECT count(*) FROM document_versions WHERE document_id = $1', [
        etp.documentId,
      ]),
    ).toBe(1);
    expect(
      await count(
        "SELECT count(*) FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'DocumentFinalized'",
        [etp.documentId],
      ),
    ).toBe(1);
  });
});
