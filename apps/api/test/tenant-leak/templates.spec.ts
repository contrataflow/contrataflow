// Templates de documento na API inteira sobre PostgreSQL real (US-107/US-108 · Sucesso, Tenant incorreto,
// Permissão, Duplicidade, Concorrência, Falha de banco): administradores nos tenants A e B,
// auditoria real na mesma transação, RLS e extensão de isolamento, índices únicos (nome por tipo
// sem maiúsculas, um rascunho por template), criação atômica (template + versão 1) e o gatilho que
// torna a versão publicada imutável. TPL-01..04/07/08 exigem TEMPLATE_VIEW/TEMPLATE_MANAGE e são
// exercitados aqui (o manifesto isenta a suíte genérica). `pnpm --filter @contrataflow/api
// test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { DEFAULT_TEMPLATE_LAYOUT, problemDetailsSchema } from '@contrataflow/validation';
import type { TemplateDto, TemplateVersionDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DocumentTypeFacade } from '#modules/document/application/document-type.facade.js';
import { createDocumentTemplate } from '#modules/document/domain/document-template.js';
import { PrismaTemplateRepository } from '#modules/document/infrastructure/prisma-template.repository.js';
import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { TOKEN_VERIFIER, MEMBERSHIP_PORT } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';
import { runAsSystem } from '#shared/context/request-context.js';
import { TenantTransaction } from '#shared/database/database.module.js';
import { newId } from '#shared/database/ids.js';

import { asTenant, startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';

const A = '0192c000-0000-7000-8000-00000000107a';
const B = '0192c000-0000-7000-8000-00000000107b';
const CARLA = '0192c000-0000-7000-8000-0000000107a1';
const DIEGO = '0192c000-0000-7000-8000-0000000107a2';
const BRUNO = '0192c000-0000-7000-8000-0000000107a3';
const BETO = '0192c000-0000-7000-8000-0000000107b1';

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [CARLA]: ['ADMIN_ORGAO'],
  [DIEGO]: ['ADMIN_ORGAO'],
  [BRUNO]: ['REQUISITANTE'],
  [BETO]: ['ADMIN_ORGAO'],
};

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code) VALUES
  ('${A}', 'prefeitura-sao-jose-tpl', 'Prefeitura de São José LEAK-A', 'MUNICIPALITY', 'ACTIVE', 'SC'),
  ('${B}', 'prefeitura-b-tpl', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC');
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${CARLA}', 'sub-carla-tpl', 'carla@a.test', true, 'Carla'),
  ('${DIEGO}', 'sub-diego-tpl', 'diego@a.test', true, 'Diego'),
  ('${BRUNO}', 'sub-bruno-tpl', 'bruno@a.test', true, 'Bruno'),
  ('${BETO}', 'sub-beto-tpl', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('0192c000-0000-7000-8000-0000000117a1', '${A}', '${CARLA}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000117a2', '${A}', '${DIEGO}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000117a3', '${A}', '${BRUNO}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000117b1', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real (perfis como registro: US-096). */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

type Row = Readonly<Record<string, unknown>>;

const section = (key: string, order: number, extra: Record<string, unknown> = {}) => ({
  key,
  title: `Seção ${key}`,
  order,
  requirement: 'REQUIRED',
  ...extra,
});

describe('Feature: templates de documento isolados por tenant sobre PostgreSQL (US-107)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let dbStopped = false;

  const typeIdOf = async (tenantId: string, code: string): Promise<string> => {
    const [row] = await db.admin<{ id: string }>(
      'SELECT id FROM document_types WHERE tenant_id = $1 AND code = $2',
      [tenantId, code],
    );
    if (!row) throw new Error(`tipo ${code} ausente em ${tenantId}`);
    return row.id;
  };
  const audits = (entityId: string) =>
    db.admin<Row>(
      `SELECT tenant_id, action, category, result, reason_code, actor_user_id, changes, metadata
         FROM audit_logs WHERE entity_id = $1 ORDER BY occurred_at`,
      [entityId],
    );
  const digestOf = async (tenantId: string) => {
    const [row] = await db.admin<{ digest: string }>(
      `SELECT md5(coalesce(string_agg(x, '|' ORDER BY x), '')) AS digest FROM (
         SELECT t::text AS x FROM document_templates t WHERE tenant_id = $1
         UNION ALL SELECT v::text FROM document_template_versions v WHERE tenant_id = $1) rows`,
      [tenantId],
    );
    return row?.digest;
  };

  const auth = (test: request.Test, subject: string, tenant: string) =>
    test.set('Authorization', api.bearer(subject)).set('X-Tenant-Id', tenant);
  const post = (subject: string, tenant: string, body: unknown) =>
    auth(request(api.server).post('/api/v1/templates'), subject, tenant)
      .set('Idempotency-Key', randomUUID())
      .send(body as object);
  const getPath = (subject: string, tenant: string, path: string) =>
    auth(request(api.server).get(`/api/v1${path}`), subject, tenant);
  const patchPath = (
    subject: string,
    tenant: string,
    path: string,
    body: unknown,
    ifMatch: string,
  ) =>
    auth(request(api.server).patch(`/api/v1${path}`), subject, tenant)
      .set('If-Match', ifMatch)
      .send(body as object);
  const problemCode = (response: request.Response) =>
    problemDetailsSchema.parse(response.body).code;

  let despachoA: string;
  let trA: string;
  let templateB: TemplateDto;

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
    });
    api = await createTestApi({
      config,
      providers: [
        { token: MEMBERSHIP_PORT, value: membership },
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

    const facade = api.app.get(DocumentTypeFacade);
    const transaction = api.app.get(TenantTransaction);
    for (const tenantId of [A, B]) {
      await runAsSystem({ name: 'Semeadura de tipos de documento (teste)', tenantId }, () =>
        transaction.run((tx) => facade.seedDefaults(tx)),
      );
    }
    despachoA = await typeIdOf(A, 'DESPACHO');
    trA = await typeIdOf(A, 'TR');
    const created = await post('sub-beto-tpl', B, {
      name: 'Ofício LEAK-B',
      documentTypeId: await typeIdOf(B, 'OFICIO'),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    templateB = (created.body as { data: TemplateDto }).data;
  });

  afterAll(async () => {
    await api.close();
    if (!dbStopped) await db.stop();
    vi.restoreAllMocks();
  });

  let despachoPadrao: TemplateDto;

  it('[Sucesso] criar template: template e versão 1 DRAFT gravados juntos, auditoria template.create', async () => {
    const response = await post('sub-carla-tpl', A, {
      name: 'Despacho padrão',
      documentTypeId: despachoA,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.headers.etag).toBe('"1"');
    despachoPadrao = (response.body as { data: TemplateDto }).data;

    const [template] = await db.admin<Row>('SELECT * FROM document_templates WHERE id = $1', [
      despachoPadrao.id,
    ]);
    expect(template).toMatchObject({
      tenant_id: A,
      document_type_id: despachoA,
      name: 'Despacho padrão',
      is_active: true,
      is_system: false,
      version: 1,
      created_by_id: CARLA,
    });
    const versions = await db.admin<Row>(
      'SELECT * FROM document_template_versions WHERE template_id = $1',
      [despachoPadrao.id],
    );
    expect(versions).toEqual([
      expect.objectContaining({
        tenant_id: A,
        version_number: 1,
        status: 'DRAFT',
        sections: [],
        field_config: {},
        import_mappings: null,
        layout: DEFAULT_TEMPLATE_LAYOUT,
      }),
    ]);
    expect(await audits(despachoPadrao.id)).toEqual([
      expect.objectContaining({
        tenant_id: A,
        action: 'template.create',
        category: 'CONFIGURATION',
        result: 'SUCCESS',
        actor_user_id: CARLA,
      }),
    ]);
  });

  it('[Sucesso] adicionar seções: UPDATE único com versão nova e auditoria template.update (resumo)', async () => {
    const versionId = despachoPadrao.draftVersion?.id ?? '';
    const response = await patchPath(
      'sub-carla-tpl',
      A,
      `/template-versions/${versionId}`,
      {
        sections: [
          section('OBJETO', 1),
          section('FUNDAMENTACAO', 2, { requirement: 'REQUIRED_OR_JUSTIFY' }),
        ],
      },
      '"1"',
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.headers.etag).toBe('"2"');
    const [row] = await db.admin<{
      sections: { key: string }[];
      version: number;
      updated_by_id: string;
    }>('SELECT sections, version, updated_by_id FROM document_template_versions WHERE id = $1', [
      versionId,
    ]);
    expect(row?.sections.map((item) => item.key)).toEqual(['OBJETO', 'FUNDAMENTACAO']);
    expect(row?.version).toBe(2);
    expect(row?.updated_by_id).toBe(CARLA);
    const records = await audits(despachoPadrao.id);
    expect(records.at(-1)).toMatchObject({
      action: 'template.update',
      changes: [{ path: 'sectionsChanged', old: null, new: ['FUNDAMENTACAO', 'OBJETO'] }],
    });
  });

  it('[Sucesso] TR: mapeamento padrão gravado e fontes do ETP de referência', async () => {
    const response = await post('sub-carla-tpl', A, { name: 'TR padrão', documentTypeId: trA });
    expect(response.status).toBe(201);
    const versionId = (response.body as { data: TemplateDto }).data.draftVersion?.id ?? '';
    const version = await getPath('sub-carla-tpl', A, `/template-versions/${versionId}`);
    const dto = (version.body as { data: TemplateVersionDto }).data;
    expect(dto.importMappings?.sections.map((mapping) => mapping.target)).toEqual([
      'OBJECT',
      'JUSTIFICATION',
      'SPECIFICATIONS',
      'ESTIMATED_VALUE',
    ]);
    expect(dto.importSources?.sectionKeys).toContain('NEED_DESCRIPTION');
  });

  it('[Tenant incorreto] ids de B → 404, tipo de B → 422 REFERENCE_NOT_FOUND, lista sem B e B intacto', async () => {
    const digestOfB = await digestOf(B);
    const versionB = templateB.draftVersion?.id ?? '';

    expect((await getPath('sub-carla-tpl', A, `/templates/${templateB.id}`)).status).toBe(404);
    expect((await getPath('sub-carla-tpl', A, `/template-versions/${versionB}`)).status).toBe(404);
    const patchVersion = await patchPath(
      'sub-carla-tpl',
      A,
      `/template-versions/${versionB}`,
      { sections: [section('INVASAO', 1)] },
      '"1"',
    );
    expect(patchVersion.status).toBe(404);
    expect(problemCode(patchVersion)).toBe('NOT_FOUND');
    expect(
      (
        await patchPath(
          'sub-carla-tpl',
          A,
          `/templates/${templateB.id}`,
          { name: 'Invasão' },
          '"1"',
        )
      ).status,
    ).toBe(404);

    const foreignType = await post('sub-carla-tpl', A, {
      name: 'Ofício com tipo de B',
      documentTypeId: await typeIdOf(B, 'OFICIO'),
    });
    expect(foreignType.status).toBe(422);
    const problem = problemDetailsSchema.parse(foreignType.body);
    expect(problem.errors).toEqual([
      expect.objectContaining({ field: 'documentTypeId', code: 'REFERENCE_NOT_FOUND' }),
    ]);
    expect(JSON.stringify(problem)).not.toContain('LEAK-B');

    const list = await getPath('sub-carla-tpl', A, '/templates?pageSize=100');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain('LEAK-B');
    expect(await digestOf(B)).toBe(digestOfB);

    // RLS: o papel da aplicação, no contexto de A, só enxerga linhas de A nas duas tabelas.
    const app = db.client('cf_app');
    const visible = await asTenant(A, () =>
      app.$tenantTransaction(
        (tx) => tx.$queryRaw<{ tenant_id: string }[]>`
          SELECT tenant_id FROM document_templates UNION SELECT tenant_id FROM document_template_versions`,
      ),
    );
    expect(visible.map((row) => row.tenant_id)).toEqual([A]);
  });

  it('[Permissão] só TEMPLATE_VIEW: lê (200) e não escreve (403 + access.denied TEMPLATE_MANAGE)', async () => {
    const versionId = despachoPadrao.draftVersion?.id ?? '';
    expect((await getPath('sub-bruno-tpl', A, `/template-versions/${versionId}`)).status).toBe(200);
    const denied = await patchPath(
      'sub-bruno-tpl',
      A,
      `/template-versions/${versionId}`,
      { sections: [section('OBJETO', 1)] },
      '"2"',
    );
    expect(denied.status).toBe(403);
    expect(problemCode(denied)).toBe('PERMISSION_DENIED');
    const [denial] = await db.admin<Row>(
      `SELECT reason_code, result, actor_user_id FROM audit_logs
        WHERE action = 'access.denied' AND actor_user_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
      [BRUNO],
    );
    expect(denial).toMatchObject({ reason_code: 'TEMPLATE_MANAGE', result: 'DENIED' });
  });

  it('[Duplicidade] nome repetido sem maiúsculas → 409; o índice lower(name) barra até o superusuário', async () => {
    const response = await post('sub-carla-tpl', A, {
      name: 'DESPACHO PADRÃO',
      documentTypeId: despachoA,
    });
    expect(response.status).toBe(409);
    expect(problemCode(response)).toBe('TEMPLATE_NAME_TAKEN');
    const [count] = await db.admin<{ total: string }>(
      'SELECT count(*) AS total FROM document_templates WHERE tenant_id = $1 AND document_type_id = $2',
      [A, despachoA],
    );
    expect(Number(count?.total)).toBe(1);
    await expect(
      db.admin(
        `INSERT INTO document_templates (id, tenant_id, document_type_id, name)
         VALUES ($1, $2, $3, 'despacho padrão')`,
        [newId(), A, despachoA],
      ),
    ).rejects.toThrow(/document_templates_tenant_id_type_lower_name_key/);
    // Criação concorrente do mesmo nome: uma 201 e uma 409.
    const [one, two] = await Promise.all([
      post('sub-carla-tpl', A, { name: 'Despacho simultâneo', documentTypeId: despachoA }),
      post('sub-diego-tpl', A, { name: 'Despacho simultâneo', documentTypeId: despachoA }),
    ]);
    expect([one.status, two.status].sort()).toEqual([201, 409]);
  });

  it('[Duplicidade] um único rascunho por template (índice parcial) e criação atômica', async () => {
    await expect(
      db.admin(
        `INSERT INTO document_template_versions (id, tenant_id, template_id, version_number, layout)
         VALUES ($1, $2, $3, 2, '{}')`,
        [newId(), A, despachoPadrao.id],
      ),
    ).rejects.toThrow(/document_template_versions_single_draft_key/);

    // Versão 1 recusada pelo banco (layout não-objeto) desfaz também o template.
    const repository = api.app.get(PrismaTemplateRepository);
    const transaction = api.app.get(TenantTransaction);
    const type = {
      id: despachoA,
      code: 'DESPACHO',
      name: 'Despacho',
      kind: 'FREE_TEXT' as const,
      systemModule: null,
      defaultConfidentiality: 'INTERNAL' as const,
    };
    const { template, draft } = createDocumentTemplate({ name: 'Despacho atômico' }, type, {
      templateId: newId(),
      versionId: newId(),
      tenantId: A,
      now: new Date(),
      userId: CARLA,
    });
    await expect(
      runAsSystem({ name: 'Criação atômica (teste)', tenantId: A }, () =>
        transaction.run((tx) => repository.insert(tx, template, { ...draft, layout: [] as never })),
      ),
    ).rejects.toThrow();
    expect(
      await db.admin('SELECT id FROM document_templates WHERE id = $1', [template.id]),
    ).toEqual([]);
  });

  it('[Concorrência] If-Match desatualizado → 412 com currentVersion; corrida → uma 200 e uma 412', async () => {
    const versionId = despachoPadrao.draftVersion?.id ?? '';
    const ok = await patchPath(
      'sub-carla-tpl',
      A,
      `/template-versions/${versionId}`,
      { sections: [section('OBJETO', 1)] },
      '"2"',
    );
    expect(ok.status).toBe(200);
    const stale = await patchPath(
      'sub-diego-tpl',
      A,
      `/template-versions/${versionId}`,
      { sections: [section('OUTRA', 1)] },
      '"2"',
    );
    expect(stale.status).toBe(412);
    expect(problemDetailsSchema.parse(stale.body)).toMatchObject({
      code: 'VERSION_CONFLICT',
      currentVersion: 3,
    });
    const [one, two] = await Promise.all([
      patchPath(
        'sub-carla-tpl',
        A,
        `/template-versions/${versionId}`,
        { sections: [section('UM', 1)] },
        '"3"',
      ),
      patchPath(
        'sub-diego-tpl',
        A,
        `/template-versions/${versionId}`,
        { sections: [section('DOIS', 1)] },
        '"3"',
      ),
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 412]);
  });

  it('[Falha de banco] gatilhos: versão publicada não muda de conteúdo e o tipo do template é imutável', async () => {
    const versionId = despachoPadrao.draftVersion?.id ?? '';
    await db.admin(
      `UPDATE document_template_versions SET status = 'PUBLISHED', published_at = now(),
              content_hash = $2 WHERE id = $1`,
      [versionId, 'a'.repeat(64)],
    );
    const response = await patchPath(
      'sub-carla-tpl',
      A,
      `/template-versions/${versionId}`,
      { sections: [section('OBJETO', 1)] },
      '"4"',
    );
    expect(response.status).toBe(409);
    expect(problemCode(response)).toBe('TEMPLATE_VERSION_NOT_DRAFT');

    const app = db.client('cf_app');
    await expect(
      asTenant(A, () =>
        app.$tenantTransaction(
          (tx) =>
            tx.$executeRaw`UPDATE document_template_versions SET sections = '[]' WHERE id = ${versionId}::uuid`,
        ),
      ),
    ).rejects.toSatisfy((error: unknown) =>
      String(error).includes('cf_template_version_not_draft'),
    );
    await expect(
      db.admin('UPDATE document_templates SET document_type_id = $2 WHERE id = $1', [
        despachoPadrao.id,
        trA,
      ]),
    ).rejects.toThrow(/imutáveis/);
    // PUBLISHED → RETIRED (US-108) continua possível sem tocar no conteúdo.
    await db.admin(
      `UPDATE document_template_versions SET status = 'RETIRED', retired_at = now() WHERE id = $1`,
      [versionId],
    );
  });

  // ─── US-108: publicar, aposentar, nova versão e padrão do tipo ─────────────────────────────
  const MFA = ['pwd', 'otp'];
  const authMfa = (test: request.Test, subject: string, tenant: string) =>
    test.set('Authorization', api.bearer(subject, { amr: MFA })).set('X-Tenant-Id', tenant);
  const publishPath = (subject: string, tenant: string, versionId: string, ifMatch: string) =>
    authMfa(
      request(api.server).post(`/api/v1/template-versions/${versionId}/publish`),
      subject,
      tenant,
    )
      .set('If-Match', ifMatch)
      .set('Idempotency-Key', randomUUID())
      .send();
  const retirePath = (subject: string, tenant: string, versionId: string, ifMatch: string) =>
    authMfa(
      request(api.server).post(`/api/v1/template-versions/${versionId}/retire`),
      subject,
      tenant,
    )
      .set('If-Match', ifMatch)
      .send();
  const newVersionPath = (subject: string, tenant: string, templateId: string) =>
    authMfa(request(api.server).post(`/api/v1/templates/${templateId}/versions`), subject, tenant)
      .set('Idempotency-Key', randomUUID())
      .send();
  const setDefaultPath = (
    subject: string,
    tenant: string,
    typeId: string,
    templateId: string,
    ifMatch: string,
  ) =>
    authMfa(
      request(api.server).put(`/api/v1/document-types/${typeId}/default-template`),
      subject,
      tenant,
    )
      .set('If-Match', ifMatch)
      .send({ templateId });
  const outbox = (aggregateId: string) =>
    db.admin<Row>(
      `SELECT tenant_id, event_type, routing_key, status, payload FROM outbox_events
        WHERE aggregate_id = $1 ORDER BY occurred_at, id`,
      [aggregateId],
    );
  const typeVersion = async (typeId: string) => {
    const [row] = await db.admin<{ version: number }>(
      'SELECT version FROM document_types WHERE id = $1',
      [typeId],
    );
    return row?.version ?? 0;
  };

  let oficioPadrao: TemplateDto;
  let oficioV1: string;
  let oficioTypeA: string;

  it('[Sucesso] publicar (US-108): versão PUBLISHED com hash e corrente do template na mesma transação; evento PENDING', async () => {
    oficioTypeA = await typeIdOf(A, 'OFICIO');
    const created = await post('sub-diego-tpl', A, {
      name: 'Ofício padrão',
      documentTypeId: oficioTypeA,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    oficioPadrao = (created.body as { data: TemplateDto }).data;
    oficioV1 = oficioPadrao.draftVersion?.id ?? '';
    const patched = await patchPath(
      'sub-diego-tpl',
      A,
      `/template-versions/${oficioV1}`,
      { sections: [section('OBJETO', 1), section('FUNDAMENTACAO', 2)] },
      '"1"',
    );
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);

    const response = await publishPath('sub-diego-tpl', A, oficioV1, '"2"');

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.headers.etag).toBe('"3"');
    const published = (response.body as { data: TemplateVersionDto }).data;
    const [version] = await db.admin<Row>(
      'SELECT status, content_hash, published_by_id, published_at FROM document_template_versions WHERE id = $1',
      [oficioV1],
    );
    expect(version).toMatchObject({
      status: 'PUBLISHED',
      content_hash: published.contentHash,
      published_by_id: DIEGO,
    });
    expect(version?.published_at).not.toBeNull();
    const [template] = await db.admin<Row>(
      'SELECT current_published_version_id, version FROM document_templates WHERE id = $1',
      [oficioPadrao.id],
    );
    expect(template).toEqual({ current_published_version_id: oficioV1, version: 2 });
    expect((await audits(oficioPadrao.id)).map((row) => row.action)).toEqual([
      'template.create',
      'template.update',
      'template.version_publish',
    ]);
    // [Falha de integração] o relay não roda aqui: o evento fica PENDING até ele voltar.
    expect(await outbox(oficioPadrao.id)).toEqual([
      expect.objectContaining({
        tenant_id: A,
        event_type: 'TemplateVersionPublished',
        routing_key: 'template.version_published',
        status: 'PENDING',
        payload: expect.objectContaining({
          templateVersionId: oficioV1,
          documentTypeCode: 'OFICIO',
          contentHash: published.contentHash,
        }) as unknown,
      }),
    ]);
    // A versão publicada é imutável no banco (gatilho), inclusive o hash.
    await expect(
      db.admin(`UPDATE document_template_versions SET content_hash = $2 WHERE id = $1`, [
        oficioV1,
        'b'.repeat(64),
      ]),
    ).rejects.toThrow(/cf_template_version_not_draft/);
  });

  it('[Sucesso] definir padrão (DTY-04): default_template_id com FK válida, auditoria e DocumentTypeChanged', async () => {
    const response = await setDefaultPath(
      'sub-diego-tpl',
      A,
      oficioTypeA,
      oficioPadrao.id,
      `"${await typeVersion(oficioTypeA)}"`,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((response.body as { data: { defaultTemplate: unknown } }).data.defaultTemplate).toEqual({
      id: oficioPadrao.id,
      name: 'Ofício padrão',
      versionNumber: 1,
    });
    const [type] = await db.admin<Row>(
      'SELECT default_template_id FROM document_types WHERE id = $1',
      [oficioTypeA],
    );
    expect(type).toEqual({ default_template_id: oficioPadrao.id });
    expect(await outbox(oficioTypeA)).toEqual([
      expect.objectContaining({
        event_type: 'DocumentTypeChanged',
        status: 'PENDING',
        payload: {
          documentTypeId: oficioTypeA,
          code: 'OFICIO',
          changedFields: ['defaultTemplateId'],
        },
      }),
    ]);
    const [audit] = await db.admin<Row>(
      `SELECT changes FROM audit_logs WHERE entity_id = $1 AND action = 'document_type.update'`,
      [oficioTypeA],
    );
    expect(audit?.changes).toEqual([
      { path: 'defaultTemplateId', old: null, new: oficioPadrao.id },
    ]);
  });

  it('[Validação] aposentar a única publicada do padrão → 409 TEMPLATE_IN_USE; com a v2 publicada, a v1 assume', async () => {
    const blocked = await retirePath('sub-diego-tpl', A, oficioV1, '"3"');
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
    expect(problemCode(blocked)).toBe('TEMPLATE_IN_USE');

    const v2 = await newVersionPath('sub-diego-tpl', A, oficioPadrao.id);
    expect(v2.status, JSON.stringify(v2.body)).toBe(201);
    const v2Id = (v2.body as { data: TemplateVersionDto }).data.id;
    expect((await publishPath('sub-diego-tpl', A, v2Id, '"1"')).status).toBe(200);
    const retired = await retirePath('sub-diego-tpl', A, v2Id, '"2"');
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);
    const [template] = await db.admin<Row>(
      'SELECT current_published_version_id FROM document_templates WHERE id = $1',
      [oficioPadrao.id],
    );
    expect(template).toEqual({ current_published_version_id: oficioV1 });
    const [row] = await db.admin<Row>(
      'SELECT status, retired_by_id FROM document_template_versions WHERE id = $1',
      [v2Id],
    );
    expect(row).toEqual({ status: 'RETIRED', retired_by_id: DIEGO });
  });

  it('[Concorrência] duas "Iniciar nova versão" simultâneas: uma 201 e outra 409 TEMPLATE_DRAFT_EXISTS; um só rascunho', async () => {
    const [one, two] = await Promise.all([
      newVersionPath('sub-diego-tpl', A, oficioPadrao.id),
      newVersionPath('sub-carla-tpl', A, oficioPadrao.id),
    ]);
    expect([one.status, two.status].sort()).toEqual([201, 409]);
    const conflict = one.status === 409 ? one : two;
    expect(problemCode(conflict)).toBe('TEMPLATE_DRAFT_EXISTS');
    const drafts = await db.admin<Row>(
      `SELECT version_number FROM document_template_versions WHERE template_id = $1 AND status = 'DRAFT'`,
      [oficioPadrao.id],
    );
    expect(drafts).toEqual([{ version_number: 3 }]);
  });

  it('[Tenant incorreto] US-108: publicar, aposentar, histórico, nova versão e padrão com ids de B → 404 e B intacto', async () => {
    const digestOfB = await digestOf(B);
    const versionB = templateB.draftVersion?.id ?? '';
    for (const response of [
      await publishPath('sub-diego-tpl', A, versionB, '"1"'),
      await retirePath('sub-diego-tpl', A, versionB, '"1"'),
      await getPath('sub-diego-tpl', A, `/templates/${templateB.id}/versions`),
      await newVersionPath('sub-diego-tpl', A, templateB.id),
      await setDefaultPath(
        'sub-diego-tpl',
        A,
        oficioTypeA,
        templateB.id,
        `"${await typeVersion(oficioTypeA)}"`,
      ),
      await setDefaultPath('sub-diego-tpl', A, await typeIdOf(B, 'OFICIO'), templateB.id, '"1"'),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(problemCode(response)).toBe('NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain('LEAK-B');
    }
    expect(await digestOf(B)).toBe(digestOfB);
  });

  it('[Permissão] US-108: só TEMPLATE_VIEW lê o histórico, mas não publica (access.denied TEMPLATE_PUBLISH)', async () => {
    const list = await authMfa(
      request(api.server).get(`/api/v1/templates/${oficioPadrao.id}/versions`),
      'sub-bruno-tpl',
      A,
    );
    expect(list.status).toBe(200);
    const denied = await publishPath('sub-bruno-tpl', A, oficioV1, '"3"');
    expect(denied.status).toBe(403);
    expect(problemCode(denied)).toBe('PERMISSION_DENIED');
    const [record] = await db.admin<Row>(
      `SELECT reason_code FROM audit_logs WHERE action = 'access.denied' AND actor_user_id = $1
        ORDER BY occurred_at DESC LIMIT 1`,
      [BRUNO],
    );
    expect(record).toEqual({ reason_code: 'TEMPLATE_PUBLISH' });
  });

  it('[Falha de banco] banco indisponível ao salvar → 503 com Retry-After', async () => {
    dbStopped = true;
    await db.container.stop();
    const response = await patchPath(
      'sub-carla-tpl',
      A,
      `/template-versions/${templateB.draftVersion?.id ?? newId()}`,
      { sections: [section('OBJETO', 1)] },
      '"1"',
    );
    expect(response.status).toBe(503);
    expect(problemCode(response)).toBe('DEPENDENCY_UNAVAILABLE');
    expect(response.headers['retry-after']).toBeDefined();
  });
});
