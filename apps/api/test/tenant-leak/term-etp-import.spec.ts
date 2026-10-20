// Importação do ETP para o TR sobre PostgreSQL real (US-037 · Sucesso, Tenant incorreto,
// Concorrência, Falha de banco, Falha de integração): a API inteira como `cf_app` (RLS) com os
// seeders reais do provisionamento. O processo (PRC-02, Ana) com dois itens vai aos estudos
// preliminares com o Rui (PLANEJAMENTO): ETP-02, seções (DOC-05), itens (DOC-07), valor manual
// (ETP-04) e "Salvar versão" (DOC-16); o ETP é levado (SQL) a FINALIZED e o processo ao
// TERMO_REFERENCIA, onde o Rui cria o TR (TRM-02). Prova a aplicação (TRM-06) numa transação só —
// falha induzida na versão IMPORT não deixa cabeçalho, seções, itens, auditoria nem evento —, o
// `TermImportedFromEtp`/`DocumentVersionCreated` PENDING, a timeline, duas aplicações simultâneas
// com o mesmo token (uma vence) e a RLS de `terms_of_reference`/`document_items`.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import type {
  EtpDetailDto,
  EtpDto,
  ProcessDto,
  ProcessItemDto,
  TermDto,
  TermImportPreviewDto,
} from '@contrataflow/validation';
import { richTextFromPlainText } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
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

const A = '0192c037-0000-7000-8000-00000000010a';
const B = '0192c037-0000-7000-8000-00000000010b';
const ORG_A = '0192c037-0000-7000-8000-0000000010a0';
const ORG_B = '0192c037-0000-7000-8000-0000000010b0';
const OBRAS = '0192c037-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c037-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c037-0000-7000-8000-0000000010b1';
const ANA = '0192c037-0000-7000-8000-0000000010c1';
const RUI = '0192c037-0000-7000-8000-0000000010c2';
const BETO = '0192c037-0000-7000-8000-0000000010c3';
const ANA_M = '0192c037-0000-7000-8000-0000000010d1';
const NOW = new Date('2026-10-20T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [RUI]: ['PLANEJAMENTO'],
  [BETO]: ['PLANEJAMENTO'],
};

const SUBJECTS = { ana: 'sub-ana-us037', rui: 'sub-rui-us037', beto: 'sub-beto-us037' } as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us037', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'santa-luzia-us037', 'Prefeitura de Santa Luzia LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
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
  ('0192c037-0000-7000-8000-0000000010d2', '${A}', '${RUI}', 'INTERNAL', 'ACTIVE'),
  ('0192c037-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c037-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
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

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- o chamador informa o tipo do corpo
function data<T>(response: request.Response): T {
  return (response.body as { data: T }).data;
}

describe('Feature: Importar dados do ETP para o TR sobre PostgreSQL (US-037)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: { contractingType: string; origin: string; un: string };

  const tenantOf = (subject: string): string => (subject === SUBJECTS.beto ? B : A);
  const call = (test: request.Test, subject: string = SUBJECTS.rui) =>
    test
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));
  const ok = (response: request.Response, status = 200) => {
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    return response;
  };

  const moveTo = (processId: string, stageKey: string) =>
    db.admin(
      `UPDATE processes p SET status = 'IN_PROGRESS', current_workflow_stage_id = ws.id,
              current_responsible_id = $2
         FROM workflow_stages ws
        WHERE p.id = $1 AND ws.workflow_version_id = p.workflow_version_id AND ws.key = $3`,
      [processId, RUI, stageKey],
    );

  /** Background: processo com 2 itens, ETP finalizado (seções, itens, valor e versão) e o TR. */
  const background = async () => {
    const created = ok(
      await call(request(api.server).post('/api/v1/processes'), SUBJECTS.ana)
        .set('Idempotency-Key', randomUUID())
        .send({
          title: `Notebooks ${words(2)}`,
          object: `Aquisição de notebooks para as escolas ${words(2)}`,
          contractingTypeId: catalog.contractingType,
          requestingSecretariatId: OBRAS,
          requestingDepartmentId: MANUTENCAO,
          originId: catalog.origin,
          pcaStatus: 'NOT_APPLICABLE',
        }),
      201,
    );
    const process = data<ProcessDto>(created);
    const items: ProcessItemDto[] = [];
    for (const description of ['Notebook 14 polegadas', 'Mouse sem fio']) {
      const item = ok(
        await call(request(api.server).post(`/api/v1/processes/${process.id}/items`), SUBJECTS.ana)
          .set('Idempotency-Key', randomUUID())
          .send({ kind: 'GOOD', description, unitOfMeasureId: catalog.un }),
        201,
      );
      items.push(data<ProcessItemDto>(item));
    }
    await moveTo(process.id, 'ESTUDOS_PRELIMINARES');
    const etp = data<EtpDto>(
      ok(
        await call(request(api.server).post(`/api/v1/processes/${process.id}/etps`))
          .set('Idempotency-Key', randomUUID())
          .send({}),
        201,
      ),
    );
    const detail = data<EtpDetailDto>(
      ok(await call(request(api.server).get(`/api/v1/etps/${etp.id}`))),
    );
    for (const [key, text] of [
      ['RECOMMENDED_SOLUTION', 'Notebooks educacionais com 8 GB de memória.'],
      ['NEED_DESCRIPTION', 'As escolas não têm equipamentos para as aulas.'],
      ['REQUIREMENTS', 'Processador de 4 núcleos e garantia de 36 meses.'],
    ] as const) {
      const revision = detail.draftContent.sections[key]?.revision ?? 0;
      ok(
        await call(request(api.server).put(`/api/v1/documents/${etp.documentId}/sections/${key}`))
          .set('If-Match', `"s${String(revision)}"`)
          .send({ content: richTextFromPlainText(text) }),
      );
    }
    const [document] = await db.admin<{ version: number }>(
      'SELECT version FROM documents WHERE id = $1',
      [etp.documentId],
    );
    ok(
      await call(request(api.server).put(`/api/v1/documents/${etp.documentId}/items`))
        .set('If-Match', `"${String(document?.version ?? 1)}"`)
        .send({
          items: [
            { processItemId: items[0]?.id, quantity: '40' },
            { processItemId: items[1]?.id, quantity: '40' },
          ],
        }),
    );
    ok(
      await call(request(api.server).patch(`/api/v1/etps/${etp.id}`))
        .set('If-Match', `"${String(etp.version)}"`)
        .send({ estimatedValueSource: 'MANUAL', estimatedTotalValue: '125000.00' }),
    );
    ok(
      await call(request(api.server).post(`/api/v1/documents/${etp.documentId}/versions`))
        .set('Idempotency-Key', randomUUID())
        .send({}),
      201,
    );
    await db.admin(
      `UPDATE documents SET status = 'FINALIZED', finalized_at = now(), finalized_by_id = $2,
              version = version + 1
        WHERE id = $1`,
      [etp.documentId, RUI],
    );
    await moveTo(process.id, 'TERMO_REFERENCIA');
    const term = data<TermDto>(
      ok(
        await call(request(api.server).post(`/api/v1/processes/${process.id}/terms`))
          .set('Idempotency-Key', randomUUID())
          .send({}),
        201,
      ),
    );
    return { process, etpId: etp.documentId, term };
  };

  const preview = async (termId: string) =>
    data<TermImportPreviewDto>(
      ok(
        await call(request(api.server).post(`/api/v1/terms/${termId}/import-etp/preview`)).send({}),
      ),
    );
  const apply = (termId: string, result: TermImportPreviewDto, subject: string = SUBJECTS.rui) =>
    call(request(api.server).post(`/api/v1/terms/${termId}/import-etp`), subject)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '"1"')
      .send({
        importToken: result.importToken,
        sections: result.sections.map((section) => section.target),
        fields: result.fields.map((field) => field.target),
        copyItems: true,
      });

  /** Tudo o que a aplicação grava (para provar o commit único e o rollback). */
  const effects = async (processId: string, termId: string) => ({
    term: await db.admin<Row>(
      `SELECT estimated_total_value::text, estimated_value_source::text, imported_from_etp_id,
              imported_from_etp_version_id, imported_by_id, version
         FROM terms_of_reference WHERE id = $1`,
      [termId],
    ),
    document: await db.admin<Row>(
      `SELECT draft_revision, version, current_version_id IS NOT NULL AS has_version
         FROM documents WHERE id = $1`,
      [termId],
    ),
    items: await db.admin<Row>(
      'SELECT quantity::text FROM document_items WHERE document_id = $1 ORDER BY sort_order',
      [termId],
    ),
    versions: await db.admin<Row>(
      'SELECT reason::text, version_number FROM document_versions WHERE document_id = $1',
      [termId],
    ),
    audit: await db.admin<Row>(
      `SELECT action FROM audit_logs WHERE process_id = $1 AND action = 'term.import_etp'`,
      [processId],
    ),
    events: await db.admin<Row>(
      `SELECT event_type, routing_key, status::text FROM outbox_events
        WHERE process_id = $1 AND (event_type = 'TermImportedFromEtp'
           OR (event_type = 'DocumentVersionCreated' AND aggregate_id = $2))
        ORDER BY event_type`,
      [processId, termId],
    ),
    timeline: await db.admin<Row>(
      `SELECT count(*)::int AS count FROM process_timeline_entries
        WHERE process_id = $1 AND type = 'TERM_IMPORTED_FROM_ETP'`,
      [processId],
    ),
  });

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

  it('[Sucesso] TRM-06 numa transação: cabeçalho, seções, itens, versão IMPORT, auditoria, timeline e eventos PENDING', async () => {
    const { process, etpId, term } = await background();
    const result = await preview(term.id);
    expect(result.sections.map((section) => section.target)).toEqual([
      'OBJECT',
      'JUSTIFICATION',
      'SPECIFICATIONS',
    ]);
    expect(result.items.count).toBe(2);
    ok(await apply(term.id, result));

    const [etpVersion] = await db.admin<{ current_version_id: string }>(
      'SELECT current_version_id FROM documents WHERE id = $1',
      [etpId],
    );
    const after = await effects(process.id, term.id);
    expect(after.term).toEqual([
      {
        estimated_total_value: '125000.00',
        estimated_value_source: 'ETP',
        imported_from_etp_id: etpId,
        imported_from_etp_version_id: etpVersion?.current_version_id,
        imported_by_id: RUI,
        version: 2,
      },
    ]);
    expect(after.document).toEqual([expect.objectContaining({ version: 2, has_version: true })]);
    expect(after.items).toEqual([{ quantity: '40.0000' }, { quantity: '40.0000' }]);
    expect(after.versions).toEqual([{ reason: 'IMPORT', version_number: 1 }]);
    expect(after.audit).toEqual([{ action: 'term.import_etp' }]);
    expect(after.events).toEqual([
      {
        event_type: 'DocumentVersionCreated',
        routing_key: 'document.version_created.tr',
        status: 'PENDING',
      },
      {
        event_type: 'TermImportedFromEtp',
        routing_key: 'term.imported_from_etp',
        status: 'PENDING',
      },
    ]);
    expect(after.timeline).toEqual([{ count: 1 }]);
    const [section] = await db.admin<{ text: string }>(
      `SELECT draft_content->'sections'->'OBJECT'->>'state' AS text FROM documents WHERE id = $1`,
      [term.id],
    );
    expect(section).toEqual({ text: 'FILLED' });
  });

  it('[Falha de banco] falha induzida na versão IMPORT desfaz cabeçalho, seções, itens, auditoria e eventos', async () => {
    const { process, term } = await background();
    const result = await preview(term.id);
    const before = await effects(process.id, term.id);
    await db.admin(`
      CREATE FUNCTION test_fail_import_version() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.reason = 'IMPORT' THEN RAISE EXCEPTION 'falha induzida no teste'; END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_fail_import_version BEFORE INSERT ON document_versions
        FOR EACH ROW EXECUTE FUNCTION test_fail_import_version();`);
    try {
      const failed = await apply(term.id, result);
      expect(failed.status).toBe(500);
      expect(await effects(process.id, term.id)).toEqual(before);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_import_version ON document_versions; DROP FUNCTION test_fail_import_version();',
      );
    }
    // Nada mudou: o mesmo token ainda vale.
    ok(await apply(term.id, result));
  });

  it('[Concorrência] duas aplicações simultâneas com o mesmo token: uma 200, a outra 412, um evento só', async () => {
    const { process, term } = await background();
    const result = await preview(term.id);
    const responses = await Promise.all([apply(term.id, result), apply(term.id, result)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 412]);
    const after = await effects(process.id, term.id);
    expect(after.versions).toEqual([{ reason: 'IMPORT', version_number: 1 }]);
    expect(after.items).toHaveLength(2);
    expect(after.events.filter((event) => event.event_type === 'TermImportedFromEtp')).toHaveLength(
      1,
    );
  });

  it('[Tenant incorreto] TR de A pelo tenant B: 404 sem revelar nem alterar; RLS de document_items', async () => {
    const { process, term } = await background();
    const result = await preview(term.id);
    const before = await effects(process.id, term.id);
    for (const response of [
      await call(
        request(api.server).post(`/api/v1/terms/${term.id}/import-etp/preview`),
        SUBJECTS.beto,
      ).send({}),
      await apply(term.id, result, SUBJECTS.beto),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain(term.code ?? '#');
    }
    expect(await effects(process.id, term.id)).toEqual(before);

    ok(await apply(term.id, result));
    const client = db.client('cf_app');
    try {
      const visible = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$queryRaw<{ count: number }[]>`
            SELECT count(*)::int AS count FROM document_items WHERE document_id = ${term.id}::uuid`,
        ),
      );
      expect(visible).toEqual([{ count: 0 }]);
      const updated = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$executeRaw`
            UPDATE terms_of_reference SET imported_from_etp_id = NULL WHERE id = ${term.id}::uuid`,
        ),
      );
      expect(updated).toBe(0);
    } finally {
      await client.$disconnect();
    }
  });
});
