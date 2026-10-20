// Menções sobre PostgreSQL real (US-072 · Sucesso, Duplicidade, Tenant incorreto, Falha de banco,
// Falha de integração): a API inteira como `cf_app` (RLS) com os seeders reais do provisionamento,
// o processo criado pelo PRC-02 e o comentário pelo CMT-02. Prova os candidatos de CMT-05 só do
// tenant (homônimo de B nunca volta — busca sem acento), o `Mention` na MESMA transação do
// comentário (falha induzida depois dele desfaz tudo), os `UserMentioned` PENDING (relay fora), os
// índices únicos parciais e o CHECK de alvo único, a FK composta e a RLS de `mentions`.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { CommentDto, MentionCandidateDto, ProcessDto } from '@contrataflow/validation';
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

const A = '0192c072-0000-7000-8000-00000000010a';
const B = '0192c072-0000-7000-8000-00000000010b';
const ORG_A = '0192c072-0000-7000-8000-0000000010a0';
const ORG_B = '0192c072-0000-7000-8000-0000000010b0';
const OBRAS = '0192c072-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c072-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c072-0000-7000-8000-0000000010b1';
const ANA = '0192c072-0000-7000-8000-0000000010c1';
const CLAUDIA = '0192c072-0000-7000-8000-0000000010c2';
const ROBERTO_B = '0192c072-0000-7000-8000-0000000010c3';
const ROBERTO_A = '0192c072-0000-7000-8000-0000000010c4';
const ANA_M = '0192c072-0000-7000-8000-0000000010d1';
const CLAUDIA_M = '0192c072-0000-7000-8000-0000000010d2';
const ROBERTO_B_M = '0192c072-0000-7000-8000-0000000010d3';
const ROBERTO_A_M = '0192c072-0000-7000-8000-0000000010d4';
const NOW = new Date('2026-10-18T12:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [ROBERTO_B]: ['LICITACOES'],
};

const SUBJECTS = { ana: 'sub-ana-us072', roberto: 'sub-roberto-us072' } as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;

// "Roberto Silva" existe nos DOIS tenants; o de A não vê o processo (sem perfil), o de B nunca volta.
const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us072', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us072', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, acronym, path, depth) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', 'SEOB', '${path(OBRAS)}', 0),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', NULL, '${path(OBRAS, MANUTENCAO)}', 1),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Setor de Manutenção LEAK-B', NULL, '${path(OBRAS_B)}', 0);
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', '${SUBJECTS.ana}', 'ana@a.test', true, 'Ana Souza'),
  ('${CLAUDIA}', NULL, 'claudia@a.test', true, 'Cláudia Ramos'),
  ('${ROBERTO_B}', '${SUBJECTS.roberto}', 'roberto@b.test', true, 'Roberto Silva'),
  ('${ROBERTO_A}', NULL, 'roberto@a.test', true, 'Roberto Silva');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('${CLAUDIA_M}', '${A}', '${CLAUDIA}', 'INTERNAL', 'ACTIVE'),
  ('${ROBERTO_B_M}', '${B}', '${ROBERTO_B}', 'INTERNAL', 'ACTIVE'),
  ('${ROBERTO_A_M}', '${A}', '${ROBERTO_A}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c072-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true),
  ('0192c072-0000-7000-8000-0000000010e2', '${A}', '${CLAUDIA_M}', '${MANUTENCAO}', true);
`;

/** Perfis do vínculo da REQUISIÇÃO (ponte por chave); terceiros usam as atribuições gravadas. */
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

const mention = (kind: 'USER' | 'DEPARTMENT', id: string, label: string) => ({
  type: 'mention',
  attrs: { kind, id, label },
});
const withMentions = (...mentions: unknown[]) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Veja ' }, ...mentions] }],
});

describe('Feature: Mencionar usuários e unidades sobre PostgreSQL (US-072)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: { contractingType: string; origin: string };

  const tenantOf = (subject: string): string => (subject === SUBJECTS.roberto ? B : A);
  const call = (test: request.Test, subject: string = SUBJECTS.ana) =>
    test
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));

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
  const candidates = (processId: string, q: string, subject: string = SUBJECTS.ana) =>
    call(
      request(api.server).get(
        `/api/v1/processes/${processId}/mention-candidates?q=${encodeURIComponent(q)}`,
      ),
      subject,
    );
  const comment = (processId: string, body: unknown) =>
    call(request(api.server).post(`/api/v1/processes/${processId}/comments`))
      .set('Idempotency-Key', randomUUID())
      .send({ body, targetType: 'PROCESS' });
  const catalogId = async (tenantId: string, type: string, code: string) => {
    const [row] = await db.admin<{ id: string }>(
      'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
      [tenantId, type, code],
    );
    if (!row) throw new Error(`${type}/${code} ausente`);
    return row.id;
  };
  const effects = async (processId: string) => ({
    comments: await db.admin<Row>('SELECT id FROM comments WHERE process_id = $1', [processId]),
    mentions: await db.admin<Row>(
      `SELECT comment_id, mentioned_user_id, mentioned_department_id, notified_at
         FROM mentions WHERE process_id = $1 ORDER BY mentioned_user_id NULLS LAST`,
      [processId],
    ),
    events: await db.admin<Row>(
      "SELECT payload, status::text FROM outbox_events WHERE process_id = $1 AND event_type = 'UserMentioned' ORDER BY occurred_at, id",
      [processId],
    ),
    audit: await db.admin<Row>(
      "SELECT metadata FROM audit_logs WHERE process_id = $1 AND action = 'comment.create'",
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
    // Cláudia vê os processos do tenant (LICITACOES com escopo TENANT, atribuição gravada — US-096).
    await db.admin(
      `INSERT INTO role_assignments (id, tenant_id, membership_id, role_id, scope_type, granted_by_id)
       SELECT $1, $2, $3, r.id, 'TENANT', $4 FROM roles r WHERE r.tenant_id = $2 AND r.key = 'LICITACOES'`,
      [randomUUID(), A, CLAUDIA_M, ANA],
    );
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

  it('[Sucesso] CMT-05 sem acento e o comentário com menções: Mention na transação, UserMentioned PENDING, auditoria só com ids', async () => {
    const process = await createProcess();
    const found = await candidates(process.id, 'claudia');
    expect(found.status, JSON.stringify(found.body)).toBe(200);
    expect((found.body as { data: MentionCandidateDto[] }).data).toEqual([
      { kind: 'USER', id: CLAUDIA, label: 'Cláudia Ramos', secondaryLabel: 'Setor de Manutenção' },
    ]);
    const units = ((await candidates(process.id, 'seob')).body as { data: MentionCandidateDto[] })
      .data;
    expect(units).toContainEqual({
      kind: 'DEPARTMENT',
      id: OBRAS,
      label: 'Secretaria de Obras',
      secondaryLabel: 'SEOB',
    });

    const response = await comment(
      process.id,
      withMentions(
        mention('USER', CLAUDIA, 'Cláudia Ramos'),
        mention('DEPARTMENT', MANUTENCAO, 'Setor de Manutenção'),
        mention('USER', CLAUDIA, 'Cláudia Ramos'),
      ),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const created = (response.body as { data: CommentDto }).data;
    expect(created.mentions).toHaveLength(2);

    const after = await effects(process.id);
    // [Duplicidade] o mesmo alvo duas vezes no corpo → um único registro.
    expect(after.mentions).toEqual([
      {
        comment_id: created.id,
        mentioned_user_id: CLAUDIA,
        mentioned_department_id: null,
        notified_at: null,
      },
      {
        comment_id: created.id,
        mentioned_user_id: null,
        mentioned_department_id: MANUTENCAO,
        notified_at: null,
      },
    ]);
    // [Falha de integração] relay fora: os eventos esperam PENDING no outbox.
    expect(after.events.map((row) => row.status)).toEqual(['PENDING', 'PENDING']);
    expect(after.audit[0]?.metadata).toMatchObject({
      mentionedUserIds: [CLAUDIA],
      mentionedDepartmentIds: [MANUTENCAO],
    });
  });

  it('[Tenant incorreto] homônimo de B nunca volta; alvos de B descartados; CMT-05 de B no processo de A → 404; RLS e FK composta', async () => {
    const process = await createProcess();
    // Roberto de A existe, mas não vê o processo; o de B é de outro tenant: nenhum aparece.
    expect(((await candidates(process.id, 'roberto')).body as { data: unknown[] }).data).toEqual(
      [],
    );
    const foreign = await candidates(process.id, 'roberto', SUBJECTS.roberto);
    expect(foreign.status).toBe(404);
    expect(problemDetailsSchema.parse(foreign.body).code).toBe('PROCESS_NOT_FOUND');

    const response = await comment(
      process.id,
      withMentions(
        mention('USER', ROBERTO_B, 'Roberto Silva'),
        mention('USER', ROBERTO_A, 'Roberto Silva'),
        mention('DEPARTMENT', OBRAS_B, 'Setor de Manutenção LEAK-B'),
      ),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const created = (response.body as { data: CommentDto }).data;
    expect(created.mentions).toEqual([]);
    const after = await effects(process.id);
    expect(after.mentions).toEqual([]);
    expect(after.events).toEqual([]);

    // RLS: com `app.tenant_id` de B, nenhuma menção de A é visível.
    await db.admin(
      `INSERT INTO mentions (id, tenant_id, comment_id, process_id, mentioned_user_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), A, created.id, process.id, CLAUDIA],
    );
    const client = db.client('cf_app');
    try {
      const visible = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$queryRaw<{ count: number }[]>`
            SELECT count(*)::int AS count FROM mentions WHERE comment_id = ${created.id}::uuid`,
        ),
      );
      expect(visible).toEqual([{ count: 0 }]);
    } finally {
      await client.$disconnect();
    }
    const insert = (fields: {
      tenantId?: string;
      userId?: string | null;
      departmentId?: string | null;
    }) =>
      db.admin(
        `INSERT INTO mentions (id, tenant_id, comment_id, process_id, mentioned_user_id, mentioned_department_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          randomUUID(),
          fields.tenantId ?? A,
          created.id,
          process.id,
          fields.userId === undefined ? ANA : fields.userId,
          fields.departmentId ?? null,
        ],
      );
    // FK composta: menção de B sobre o comentário de A; unidade de B numa menção de A.
    await expect(insert({ tenantId: B })).rejects.toThrow();
    await expect(insert({ userId: null, departmentId: OBRAS_B })).rejects.toThrow();
    // CHECK de alvo único e índice único parcial por alvo (rede de segurança de RN-CMT-23).
    await expect(insert({ userId: null })).rejects.toThrow();
    await expect(insert({ departmentId: MANUTENCAO })).rejects.toThrow();
    await expect(insert({ userId: CLAUDIA })).rejects.toThrow();
  });

  it('[Falha de banco] falha induzida DEPOIS de gravar a menção desfaz comentário, menção e eventos', async () => {
    const process = await createProcess();
    await db.admin(`
      CREATE FUNCTION test_fail_mention_event() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.event_type = 'UserMentioned' THEN
          RAISE EXCEPTION 'falha induzida no teste';
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_fail_mention_event BEFORE INSERT ON outbox_events
        FOR EACH ROW EXECUTE FUNCTION test_fail_mention_event();`);
    try {
      const failed = await comment(process.id, withMentions(mention('USER', CLAUDIA, 'Cláudia')));
      expect(failed.status).toBe(500);
      expect(await effects(process.id)).toEqual({
        comments: [],
        mentions: [],
        events: [],
        audit: [],
      });
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_mention_event ON outbox_events; DROP FUNCTION test_fail_mention_event();',
      );
    }
  });
});
