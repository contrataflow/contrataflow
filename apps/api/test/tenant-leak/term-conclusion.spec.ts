// Validação e conclusão do TR sobre PostgreSQL real (US-039 · Sucesso, Validação, Tenant
// incorreto, Concorrência, Falha de banco, Falha de integração): a API inteira como `cf_app` (RLS)
// com os seeders reais, o processo pelo PRC-02 (Ana) com 3 itens, o ETP pelo ETP-02 (Carla) com as
// quantidades 100/20/40 (DOC-07) e finalizado, e o TR pelo TRM-02 (Carla) completo — seções, itens
// (DOC-07), valor manual, critério de julgamento, adjudicação e garantia (TRM-04). Prova o DOC-08
// com as pendências do `TermDocumentValidator` (divergência de quantidade com o ETP pelo
// `processItemId`), o DOC-10 criando a versão `FINALIZATION` com o snapshot e o `content_hash`
// corretos e o `DocumentFinalized` (`document.finalized.tr`, com `typedSummary` sem o valor) PENDING
// no outbox (sem relay), a falha induzida no meio da transação (no outbox, DEPOIS da versão e da
// auditoria) desfazendo tudo — status, versão, auditoria e eventos —, o TR de A invisível ao tenant
// B (404) e duas conclusões paralelas com o mesmo `If-Match` (exatamente um 200, o outro 412).
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { documentSnapshotSchema, problemDetailsSchema } from '@contrataflow/validation';
import type {
  DocumentDto,
  EtpDto,
  ProcessDto,
  ProcessItemDto,
  TermDto,
} from '@contrataflow/validation';
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
import { TERM_CLOCK } from '../../src/modules/term/application/ports.js';
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

const A = '0192c039-0000-7000-8000-00000000010a';
const B = '0192c039-0000-7000-8000-00000000010b';
const ORG_A = '0192c039-0000-7000-8000-0000000010a0';
const ORG_B = '0192c039-0000-7000-8000-0000000010b0';
const OBRAS = '0192c039-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c039-0000-7000-8000-0000000010a2';
const ANA = '0192c039-0000-7000-8000-0000000010c1';
const CARLA = '0192c039-0000-7000-8000-0000000010c2';
const BETO = '0192c039-0000-7000-8000-0000000010c3';
const ANA_M = '0192c039-0000-7000-8000-0000000010d1';
const NOW = new Date('2026-10-20T15:00:00.000Z');
const MFA = ['pwd', 'otp'];
const SECTION_TEXT =
  'Texto do termo de referência elaborado pela equipe de planejamento, com os elementos do art. 6º, XXIII, da Lei 14.133/2021, sem lacunas pendentes.';
const ETP_QUANTITIES = ['100', '20', '40'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [CARLA]: ['PLANEJAMENTO'],
  [BETO]: ['PLANEJAMENTO'],
};

const SUBJECTS = {
  ana: 'sub-ana-us039',
  carla: 'sub-carla-us039',
  beto: 'sub-beto-us039',
} as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us039', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'santa-luzia-us039', 'Prefeitura de Santa Luzia LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura de Santa Luzia LEAK-B', 'PMSL', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1);
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', '${SUBJECTS.ana}', 'ana-us039@a.test', true, 'Ana Souza'),
  ('${CARLA}', '${SUBJECTS.carla}', 'carla-us039@a.test', true, 'Carla Lima'),
  ('${BETO}', '${SUBJECTS.beto}', 'beto-us039@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c039-0000-7000-8000-0000000010d2', '${A}', '${CARLA}', 'INTERNAL', 'ACTIVE'),
  ('0192c039-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c039-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real (atribuições: US-096). */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

const words = (count: number) =>
  Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

const VIOLATIONS = z.object({
  data: z.object({ violations: z.array(z.looseObject({ code: z.string() })) }),
});

describe('Feature: Validar e concluir o TR sobre PostgreSQL (US-039)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: { contractingType: string; origin: string; un: string; menorPreco: string };

  const tenantOf = (subject: string): string => (subject === SUBJECTS.beto ? B : A);
  const call = (test: request.Test, subject: string = SUBJECTS.carla) =>
    test
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));

  const moveTo = (processId: string, stageKey: string) =>
    db.admin(
      `UPDATE processes p SET status = 'IN_PROGRESS', current_workflow_stage_id = ws.id,
              current_responsible_id = $2
         FROM workflow_stages ws
        WHERE p.id = $1 AND ws.workflow_version_id = p.workflow_version_id AND ws.key = $3`,
      [processId, CARLA, stageKey],
    );
  const documentVersion = async (documentId: string) => {
    const [row] = await db.admin<{ version: number }>(
      'SELECT version FROM documents WHERE id = $1',
      [documentId],
    );
    return row?.version ?? 0;
  };
  const documentStatus = async (documentId: string) => {
    const [row] = await db.admin<{ status: string }>(
      'SELECT status::text FROM documents WHERE id = $1',
      [documentId],
    );
    return row?.status;
  };
  const putItems = async (documentId: string, items: readonly Record<string, unknown>[]) =>
    call(request(api.server).put(`/api/v1/documents/${documentId}/items`))
      .set('If-Match', `"${String(await documentVersion(documentId))}"`)
      .send({ items });
  const finalize = (
    documentId: string,
    ifMatch: number,
    options: { subject?: string; acknowledgedWarnings?: string[] } = {},
  ) =>
    call(request(api.server).post(`/api/v1/documents/${documentId}/finalize`), options.subject)
      .set('If-Match', `"${String(ifMatch)}"`)
      .set('Idempotency-Key', randomUUID())
      .send(
        options.acknowledgedWarnings === undefined
          ? {}
          : { acknowledgedWarnings: options.acknowledgedWarnings },
      );
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
   * Background: processo (PRC-02, Ana) com 3 itens; ETP finalizado com 100/20/40; TR (TRM-02,
   * Carla) completo com as quantidades dadas (as do ETP por padrão).
   */
  const background = async (quantities: readonly string[] = ETP_QUANTITIES) => {
    const response = await call(request(api.server).post('/api/v1/processes'), SUBJECTS.ana)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Materiais de construção ${words(2)}`,
        object: `Aquisição de materiais de construção para as obras ${words(2)}`,
        contractingTypeId: catalog.contractingType,
        requestingSecretariatId: OBRAS,
        requestingDepartmentId: MANUTENCAO,
        originId: catalog.origin,
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const process = (response.body as { data: ProcessDto }).data;
    const items: ProcessItemDto[] = [];
    for (const description of ['Cimento CP-II', 'Areia média', 'Brita 1']) {
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
    const etpItems = await putItems(
      etp.documentId,
      items.map((item, index) => ({ processItemId: item.id, quantity: ETP_QUANTITIES[index] })),
    );
    expect(etpItems.status, JSON.stringify(etpItems.body)).toBe(200);
    await db.admin(
      `UPDATE documents SET status = 'FINALIZED', finalized_at = now(), finalized_by_id = $2,
              version = version + 1
        WHERE id = $1`,
      [etp.documentId, CARLA],
    );

    await moveTo(process.id, 'TERMO_REFERENCIA');
    const created = await call(request(api.server).post(`/api/v1/processes/${process.id}/terms`))
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const term = (created.body as { data: TermDto }).data;

    // Seções do template preenchidas (o trabalho da US-036), direto no rascunho.
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
      [term.documentId, SECTION_TEXT, NOW.toISOString(), CARLA],
    );
    const trItems = await putItems(
      term.documentId,
      items.map((item, index) => ({
        processItemId: item.id,
        quantity: quantities[index],
        sortOrder: index,
      })),
    );
    expect(trItems.status, JSON.stringify(trItems.body)).toBe(200);
    const patched = await call(request(api.server).patch(`/api/v1/terms/${term.id}`))
      .set('If-Match', `"${String(term.version)}"`)
      .send({
        estimatedValueSource: 'MANUAL',
        estimatedTotalValue: '98000.00',
        selectionCriterionId: catalog.menorPreco,
        awardType: 'BY_ITEM',
        productWarrantyMonths: 12,
      });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    return { process, term, items };
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
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] DOC-10 cria a versão FINALIZATION com snapshot e hash e deixa o DocumentFinalized PENDING sem o valor', async () => {
    const { term } = await background();
    expect(await violationsOf(term.documentId)).toEqual([]);

    const response = await finalize(term.documentId, await documentVersion(term.documentId));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((response.body as { data: DocumentDto }).data.status).toBe('FINALIZED');

    const [version] = await db.admin<{ reason: string; content: unknown; content_hash: string }>(
      'SELECT reason::text, content, content_hash FROM document_versions WHERE document_id = $1',
      [term.documentId],
    );
    expect(version?.reason).toBe('FINALIZATION');
    const snapshot = documentSnapshotSchema.parse(version?.content);
    expect(snapshot.header).toMatchObject({
      estimatedValueSource: 'MANUAL',
      estimatedTotalValue: '98000.00',
      selectionCriterionId: catalog.menorPreco,
      awardType: 'BY_ITEM',
      productWarrantyMonths: 12,
    });
    expect(snapshot.collections.items).toHaveLength(3);
    expect(version?.content_hash).toBe(snapshotHash(snapshot));

    // Falha de integração: sem relay, os eventos ficam PENDING no outbox.
    const events = await db.admin<{
      event_type: string;
      routing_key: string;
      status: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT event_type, routing_key, status::text, payload FROM outbox_events
        WHERE aggregate_id = $1 AND event_type IN ('DocumentFinalized', 'DocumentVersionCreated')
        ORDER BY event_type DESC`,
      [term.documentId],
    );
    expect(events.map(({ payload: _payload, ...row }) => row)).toEqual([
      {
        event_type: 'DocumentVersionCreated',
        routing_key: 'document.version_created.tr',
        status: 'PENDING',
      },
      { event_type: 'DocumentFinalized', routing_key: 'document.finalized.tr', status: 'PENDING' },
    ]);
    expect(events[1]?.payload).toMatchObject({
      typedSummary: {
        estimatedTotalValueMasked: false,
        itemsCount: 3,
        warningsAcknowledgedCount: 0,
      },
    });
    expect(JSON.stringify(events)).not.toContain('98000');
    expect(
      await count(
        `SELECT count(*) FROM audit_logs WHERE entity_id = $1 AND action = 'document.finalize'`,
        [term.documentId],
      ),
    ).toBe(1);
  });

  it('[Validação] divergência com o ETP pelo processItemId: aviso no DOC-08, 422 sem reconhecer e 200 reconhecendo', async () => {
    const { term } = await background(['100', '20', '50']);
    expect(await violationsOf(term.documentId)).toEqual(['TR_ITEM_QUANTITY_DIVERGENT']);
    const version = await documentVersion(term.documentId);
    const refused = await finalize(term.documentId, version);
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(problemDetailsSchema.parse(refused.body).code).toBe('WARNINGS_NOT_ACKNOWLEDGED');
    expect(await documentStatus(term.documentId)).toBe('DRAFT');
    const done = await finalize(term.documentId, version, {
      acknowledgedWarnings: ['TR_ITEM_QUANTITY_DIVERGENT'],
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const [audit] = await db.admin<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_logs WHERE entity_id = $1 AND action = 'document.finalize'`,
      [term.documentId],
    );
    expect(audit?.metadata).toMatchObject({
      warningsAcknowledged: [expect.objectContaining({ code: 'TR_ITEM_QUANTITY_DIVERGENT' })],
    });
  });

  it('[Falha de banco] falha induzida no outbox, DEPOIS da versão e da auditoria, desfaz a conclusão inteira', async () => {
    const { term } = await background();
    const version = await documentVersion(term.documentId);
    await db.admin(`
      CREATE FUNCTION test_fail_term_finalized() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.event_type = 'DocumentFinalized' THEN
          RAISE EXCEPTION 'falha induzida no teste';
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_fail_term_finalized BEFORE INSERT ON outbox_events
        FOR EACH ROW EXECUTE FUNCTION test_fail_term_finalized();`);
    try {
      const failed = await finalize(term.documentId, version);
      expect(failed.status, JSON.stringify(failed.body)).toBeGreaterThanOrEqual(500);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_term_finalized ON outbox_events; DROP FUNCTION test_fail_term_finalized();',
      );
    }
    expect(await documentStatus(term.documentId)).toBe('DRAFT');
    expect(await documentVersion(term.documentId)).toBe(version);
    expect(
      await count('SELECT count(*) FROM document_versions WHERE document_id = $1', [
        term.documentId,
      ]),
    ).toBe(0);
    expect(
      await count(
        `SELECT count(*) FROM audit_logs WHERE entity_id = $1 AND action = 'document.finalize'`,
        [term.documentId],
      ),
    ).toBe(0);
    expect(
      await count(
        `SELECT count(*) FROM outbox_events WHERE aggregate_id = $1
            AND event_type IN ('DocumentFinalized', 'DocumentVersionCreated')`,
        [term.documentId],
      ),
    ).toBe(0);
    // Sem a falha, a mesma conclusão passa.
    expect((await finalize(term.documentId, version)).status).toBe(200);
  });

  it('[Tenant incorreto] TR de A invisível ao tenant B: DOC-08 e DOC-10 → 404 sem alterar nada', async () => {
    const { term } = await background();
    const version = await documentVersion(term.documentId);
    const finalized = await finalize(term.documentId, version, { subject: SUBJECTS.beto });
    expect(finalized.status, JSON.stringify(finalized.body)).toBe(404);
    expect(problemDetailsSchema.parse(finalized.body).code).toBe('NOT_FOUND');
    const validation = await call(
      request(api.server).get(`/api/v1/documents/${term.documentId}/validation`),
      SUBJECTS.beto,
    );
    expect(validation.status, JSON.stringify(validation.body)).toBe(404);
    expect(await documentStatus(term.documentId)).toBe('DRAFT');
    expect(await documentVersion(term.documentId)).toBe(version);
  });

  it('[Concorrência] duas conclusões paralelas com o mesmo If-Match: exatamente um 200 e um 412', async () => {
    const { process, term } = await background();
    await db.admin(
      `INSERT INTO process_participants (id, tenant_id, process_id, user_id, role, granted_by_id)
       VALUES ($1, $2, $3, $4, 'COLLABORATOR', $5)`,
      [randomUUID(), A, process.id, ANA, CARLA],
    );
    const version = await documentVersion(term.documentId);
    const [one, two] = await Promise.all([
      finalize(term.documentId, version),
      finalize(term.documentId, version, { subject: SUBJECTS.ana }),
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 412]);
    const loser = one.status === 412 ? one : two;
    expect(problemDetailsSchema.parse(loser.body).code).toBe('VERSION_CONFLICT');
    expect(
      await count('SELECT count(*) FROM document_versions WHERE document_id = $1', [
        term.documentId,
      ]),
    ).toBe(1);
    expect(
      await count(
        "SELECT count(*) FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'DocumentFinalized'",
        [term.documentId],
      ),
    ).toBe(1);
  });
});
