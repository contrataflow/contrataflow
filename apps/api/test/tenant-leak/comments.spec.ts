// Comentários sobre PostgreSQL real (US-071 · Sucesso, Tenant incorreto, Falha de banco, Falha de
// integração): a API inteira como `cf_app` (RLS) com os seeders reais do provisionamento, o
// processo criado pelo PRC-02 e os comentários pelos CMT-01..04. Prova a transação única por falha
// induzida DEPOIS de gravar o comentário (nada persiste: comentário, timeline, auditoria e
// outbox), as respostas da página numa consulta só (janela `ROW_NUMBER` por pai), os eventos
// `PENDING` (relay fora — a notificação `COMMENT_REPLY` sai quando ele voltar), os checks do banco
// (alvo × documento, texto 1–10.000, colunas imutáveis), a FK composta e a RLS (comentário de
// outro tenant). `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { commentBodyFromText, problemDetailsSchema } from '@contrataflow/validation';
import type { CommentDto, CommentThreadDto, ProcessDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
import { COMMENT_CLOCK } from '../../src/modules/collaboration/application/ports.js';
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

const A = '0192c071-0000-7000-8000-00000000010a';
const B = '0192c071-0000-7000-8000-00000000010b';
const ORG_A = '0192c071-0000-7000-8000-0000000010a0';
const ORG_B = '0192c071-0000-7000-8000-0000000010b0';
const OBRAS = '0192c071-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c071-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c071-0000-7000-8000-0000000010b1';
const ANA = '0192c071-0000-7000-8000-0000000010c1';
const CARLA = '0192c071-0000-7000-8000-0000000010c2';
const BETO = '0192c071-0000-7000-8000-0000000010c3';
const ANA_M = '0192c071-0000-7000-8000-0000000010d1';
const CARLA_M = '0192c071-0000-7000-8000-0000000010d2';
const NOW = new Date('2026-10-17T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [CARLA]: ['REQUISITANTE'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const SUBJECTS = {
  ana: 'sub-ana-us071',
  carla: 'sub-carla-us071',
  beto: 'sub-beto-us071',
} as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us071', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us071', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
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
  ('${CARLA}', '${SUBJECTS.carla}', 'carla@a.test', true, 'Carla Dias'),
  ('${BETO}', '${SUBJECTS.beto}', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('${CARLA_M}', '${A}', '${CARLA}', 'INTERNAL', 'ACTIVE'),
  ('0192c071-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c071-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true),
  ('0192c071-0000-7000-8000-0000000010e2', '${A}', '${CARLA_M}', '${MANUTENCAO}', true);
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

describe('Feature: Comentar no processo e em documentos sobre PostgreSQL (US-071)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: { contractingType: string; origin: string };

  const tenantOf = (subject: string): string => (subject === SUBJECTS.beto ? B : A);
  const call = (test: request.Test, subject: string = SUBJECTS.ana) =>
    test
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));

  /** Processo pelo PRC-02 (Ana responsável), em andamento. */
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
    await db.admin(`UPDATE processes SET status = 'IN_PROGRESS' WHERE id = $1`, [process.id]);
    return process;
  };
  const comment = (
    processId: string,
    text: string,
    extra: Record<string, unknown> = {},
    subject: string = SUBJECTS.ana,
  ) =>
    call(request(api.server).post(`/api/v1/processes/${processId}/comments`), subject)
      .set('Idempotency-Key', randomUUID())
      .send({ body: commentBodyFromText(text), targetType: 'PROCESS', ...extra });
  const created = (response: request.Response): CommentDto => {
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return (response.body as { data: CommentDto }).data;
  };
  const catalogId = async (tenantId: string, type: string, code: string) => {
    const [row] = await db.admin<{ id: string }>(
      'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
      [tenantId, type, code],
    );
    if (!row) throw new Error(`${type}/${code} ausente`);
    return row.id;
  };
  /** Tudo que os comentários gravam do processo (para provar o rollback). */
  const effects = async (processId: string) => ({
    comments: await db.admin<Row>(
      `SELECT id, parent_id, body_text, body, edited_at IS NOT NULL AS edited,
              deleted_at IS NOT NULL AS deleted, version
         FROM comments WHERE process_id = $1 ORDER BY created_at, id`,
      [processId],
    ),
    timeline: await db.admin<Row>(
      "SELECT type::text, params FROM process_timeline_entries WHERE process_id = $1 AND type::text LIKE 'COMMENT_%' ORDER BY occurred_at, id",
      [processId],
    ),
    audit: await db.admin<Row>(
      "SELECT action, changes, metadata FROM audit_logs WHERE process_id = $1 AND action LIKE 'comment.%' ORDER BY occurred_at, id",
      [processId],
    ),
    events: await db.admin<Row>(
      "SELECT event_type, payload, status::text FROM outbox_events WHERE process_id = $1 AND event_type LIKE 'Comment%' ORDER BY occurred_at, id",
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
        { token: COMMENT_CLOCK, value: () => NOW },
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
    await runTenantSeeders(api, A);
    await runTenantSeeders(api, B);
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

  it('[Sucesso] comentar, responder, editar e excluir: threads numa consulta, timeline, auditoria e eventos PENDING', async () => {
    const process = await createProcess();
    const root = created(await comment(process.id, 'Precisamos rever o item 2.'));
    expect(root).toMatchObject({ version: 1, author: { name: 'Ana Souza' } });
    const reply = created(
      await comment(process.id, 'Revisado.', { parentId: root.id }, SUBJECTS.carla),
    );
    expect(reply.parentId).toBe(root.id);

    const listed = await call(request(api.server).get(`/api/v1/processes/${process.id}/comments`));
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const [thread] = (listed.body as { data: CommentThreadDto[] }).data;
    expect(thread).toMatchObject({ id: root.id, replyCount: 1, replies: [{ id: reply.id }] });

    const edited = await call(request(api.server).patch(`/api/v1/comments/${root.id}`))
      .set('If-Match', '"1"')
      .send({ body: commentBodyFromText('Precisamos rever os itens 2 e 3.') });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const removed = await call(
      request(api.server).delete(`/api/v1/comments/${reply.id}`),
      SUBJECTS.carla,
    ).set('If-Match', '"1"');
    expect(removed.status, JSON.stringify(removed.body)).toBe(204);

    const after = await effects(process.id);
    expect(after.comments.map((row) => [row.id, row.edited, row.deleted, row.version])).toEqual([
      [root.id, true, false, 2],
      [reply.id, false, true, 2],
    ]);
    expect(after.comments[0]?.body_text).toBe('Precisamos rever os itens 2 e 3.');
    expect(after.comments[0]?.body).toEqual(
      commentBodyFromText('Precisamos rever os itens 2 e 3.'),
    );
    expect(after.timeline.map((row) => row.type)).toEqual(['COMMENT_ADDED', 'COMMENT_ADDED']);
    expect(after.timeline[0]?.params).toMatchObject({ excerpt: 'Precisamos rever o item 2.' });
    expect(after.audit.map((row) => row.action)).toEqual([
      'comment.create',
      'comment.create',
      'comment.update',
      'comment.delete',
    ]);
    // Conteúdo na auditoria só como hash e tamanho (DEC-138 · RL-05).
    expect(JSON.stringify(after.audit)).not.toContain('rever o item 2');
    // [Falha de integração] relay fora: os eventos ficam PENDING, só com ids e o alvo.
    expect(after.events.map((row) => [row.event_type, row.status])).toEqual([
      ['CommentCreated', 'PENDING'],
      ['CommentCreated', 'PENDING'],
      ['CommentUpdated', 'PENDING'],
      ['CommentDeleted', 'PENDING'],
    ]);
    expect(after.events[1]?.payload).toEqual({
      commentId: reply.id,
      targetType: 'PROCESS',
      documentId: null,
      sectionKey: null,
      parentId: root.id,
      parentAuthorId: ANA,
    });
  });

  it('[Falha de banco] falha induzida DEPOIS de gravar o comentário desfaz comentário, timeline, auditoria e evento', async () => {
    const process = await createProcess();
    await db.admin(`
      CREATE FUNCTION test_fail_comment_timeline() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.type::text = 'COMMENT_ADDED' THEN
          RAISE EXCEPTION 'falha induzida no teste';
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_fail_comment_timeline BEFORE INSERT ON process_timeline_entries
        FOR EACH ROW EXECUTE FUNCTION test_fail_comment_timeline();`);
    try {
      const failed = await comment(process.id, 'Não deve persistir.');
      expect(failed.status).toBe(500);
      expect(await effects(process.id)).toEqual({
        comments: [],
        timeline: [],
        audit: [],
        events: [],
      });
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_comment_timeline ON process_timeline_entries; DROP FUNCTION test_fail_comment_timeline();',
      );
    }
  });

  it('[Tenant incorreto] comentário de A pelo tenant B: 404 sem alterar; referências inexistentes: 422; RLS, FK composta e checks', async () => {
    const process = await createProcess();
    const root = created(await comment(process.id, 'Comentário de A.'));
    const before = await effects(process.id);

    const asBeto = (test: request.Test) => call(test, SUBJECTS.beto);
    for (const [response, code] of [
      [
        await asBeto(request(api.server).patch(`/api/v1/comments/${root.id}`))
          .set('If-Match', '"1"')
          .send({ body: commentBodyFromText('Alterado por B') }),
        'COMMENT_NOT_FOUND',
      ],
      [
        await asBeto(request(api.server).delete(`/api/v1/comments/${root.id}`))
          .set('If-Match', '"1"')
          .send({ reason: 'Moderação vinda de outro tenant.' }),
        'COMMENT_NOT_FOUND',
      ],
      [
        await asBeto(request(api.server).get(`/api/v1/processes/${process.id}/comments`)),
        'PROCESS_NOT_FOUND',
      ],
      [
        await asBeto(request(api.server).post(`/api/v1/processes/${process.id}/comments`))
          .set('Idempotency-Key', randomUUID())
          .send({ body: commentBodyFromText('De B.'), targetType: 'PROCESS' }),
        'PROCESS_NOT_FOUND',
      ],
    ] as const) {
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(problemDetailsSchema.parse(response.body).code).toBe(code);
    }
    expect(await effects(process.id)).toEqual(before);

    // Documento ou pai invisíveis (de outro tenant ou inexistentes): 422 sem revelar o registro.
    for (const [extra, field] of [
      [{ targetType: 'DOCUMENT', documentId: randomUUID() }, 'documentId'],
      [{ parentId: randomUUID() }, 'parentId'],
    ] as const) {
      const response = await comment(process.id, 'Referência estranha.', extra);
      expect(response.status).toBe(422);
      expect(
        problemDetailsSchema.parse(response.body).errors.map((error) => [error.field, error.code]),
      ).toEqual([[field, 'REFERENCE_NOT_FOUND']]);
    }

    // RLS: com `app.tenant_id` de B, nenhum comentário de A é visível nem alterável.
    const client = db.client('cf_app');
    try {
      const visible = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$queryRaw<{ count: number }[]>`
            SELECT count(*)::int AS count FROM comments WHERE id = ${root.id}::uuid`,
        ),
      );
      expect(visible).toEqual([{ count: 0 }]);
      const updated = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$executeRaw`
            UPDATE comments SET body_text = 'LEAK-B' WHERE id = ${root.id}::uuid`,
        ),
      );
      expect(updated).toBe(0);
    } finally {
      await client.$disconnect();
    }

    const insert = (fields: {
      tenantId?: string;
      targetType?: string;
      documentId?: string | null;
      sectionKey?: string | null;
      parentId?: string | null;
      bodyText?: string;
    }) =>
      db.admin(
        `INSERT INTO comments (id, tenant_id, process_id, target_type, document_id, section_key,
                               parent_id, author_id, body, body_text)
         VALUES ($1, $2, $3, $4::comment_target_type, $5, $6, $7, $8, '{"type":"doc"}'::jsonb, $9)`,
        [
          randomUUID(),
          fields.tenantId ?? A,
          process.id,
          fields.targetType ?? 'PROCESS',
          fields.documentId ?? null,
          fields.sectionKey ?? null,
          fields.parentId ?? null,
          ANA,
          fields.bodyText ?? 'Texto direto.',
        ],
      );
    // FK composta: comentário de B sobre o processo (e o pai) de A é recusado pelo banco.
    await expect(insert({ tenantId: B, parentId: root.id })).rejects.toThrow();
    // CHECKs: alvo DOCUMENT sem documento; PROCESS com seção; texto vazio.
    await expect(insert({ targetType: 'DOCUMENT' })).rejects.toThrow();
    await expect(insert({ sectionKey: 'REQUIREMENTS' })).rejects.toThrow();
    await expect(insert({ bodyText: '' })).rejects.toThrow();
    // Autor e alvo imutáveis (gatilho).
    await expect(
      db.admin('UPDATE comments SET author_id = $1 WHERE id = $2', [CARLA, root.id]),
    ).rejects.toThrow();
  });
});
