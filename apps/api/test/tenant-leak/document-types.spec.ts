// Tipos de documento na API inteira sobre PostgreSQL real (US-061 · Tenant incorreto, Permissão,
// Duplicidade, Concorrência, Falha de banco): administradores nos tenants A e B, auditoria e
// outbox reais na mesma transação, RLS e extensão de isolamento. A suíte HTTP genérica
// (`tenant-leak.spec.ts`) cobre DTY-01; DTY-02/03 exigem `DOCUMENT_TYPE_MANAGE` e são exercitados
// aqui. Perfis ainda não existem como registro (US-096): o vínculo ganha `roleKeys` por uma porta
// de teste sobre a `MembershipPort` real. `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { DocumentTypeDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DocumentTypeFacade } from '#modules/document/application/document-type.facade.js';
import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { TOKEN_VERIFIER, MEMBERSHIP_PORT } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';
import { runAsSystem } from '#shared/context/request-context.js';
import { TenantTransaction } from '#shared/database/database.module.js';

import { startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';

const A = '0192c000-0000-7000-8000-00000000061a';
const B = '0192c000-0000-7000-8000-00000000061b';
const MARTA = '0192c000-0000-7000-8000-0000000061a1';
const LUCIA = '0192c000-0000-7000-8000-0000000061a2';
const BETO = '0192c000-0000-7000-8000-0000000061b1';
const HEITOR = '0192c000-0000-7000-8000-0000000061b2';
const MARTA_SUBJECT = 'sub-marta';
const LUCIA_SUBJECT = 'sub-lucia';
const BETO_SUBJECT = 'sub-beto';
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [MARTA]: ['ADMIN_ORGAO'],
  [LUCIA]: ['GESTOR_CONTRATACOES'],
  [BETO]: ['ADMIN_ORGAO'],
  [HEITOR]: ['GESTOR_CONTRATACOES'],
};

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code) VALUES
  ('${A}', 'prefeitura-a-dty', 'Prefeitura A LEAK-A', 'MUNICIPALITY', 'ACTIVE', 'SC'),
  ('${B}', 'prefeitura-b-dty', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC');
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${MARTA}', 'sub-marta', 'marta@a.test', true, 'Marta Ribeiro'),
  ('${LUCIA}', 'sub-lucia', 'lucia@a.test', true, 'Lúcia Matos'),
  ('${BETO}', 'sub-beto', 'beto@b.test', true, 'Beto LEAK-B'),
  ('${HEITOR}', 'sub-heitor', 'heitor@b.test', true, 'Heitor LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('0192c000-0000-7000-8000-0000000071a1', '${A}', '${MARTA}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000071a2', '${A}', '${LUCIA}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000071b1', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000071b2', '${B}', '${HEITOR}', 'INTERNAL', 'ACTIVE');
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

describe('Feature: tipos de documento isolados por tenant sobre PostgreSQL (US-061)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let dbStopped = false;

  const as = (subject: string, amr: readonly string[] = MFA) => api.bearer(subject, { amr });
  const typesOf = (tenantId: string) =>
    db.admin<Row>(
      'SELECT id, code, name, version, is_active FROM document_types WHERE tenant_id = $1 ORDER BY code',
      [tenantId],
    );
  const digestOf = async (tenantId: string) => {
    const [row] = await db.admin<{ digest: string }>(
      `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest
         FROM document_types t WHERE tenant_id = $1`,
      [tenantId],
    );
    return row?.digest;
  };
  const events = (aggregateId: string) =>
    db.admin<Row>(
      `SELECT tenant_id, event_type, routing_key, status, payload FROM outbox_events
        WHERE aggregate_id = $1 ORDER BY occurred_at`,
      [aggregateId],
    );
  const audits = (entityId: string) =>
    db.admin<Row>(
      `SELECT tenant_id, action, category, result, reason_code, actor_user_id, changes, metadata
         FROM audit_logs WHERE entity_id = $1 ORDER BY occurred_at`,
      [entityId],
    );

  const post = (subject: string, tenant: string, body: unknown, key = randomUUID(), amr = MFA) =>
    request(api.server)
      .post('/api/v1/document-types')
      .set('Authorization', as(subject, amr))
      .set('X-Tenant-Id', tenant)
      .set('Idempotency-Key', key)
      .send(body as object);
  const patch = (
    subject: string,
    tenant: string,
    id: string,
    body: unknown,
    ifMatch: string,
    amr = MFA,
  ) =>
    request(api.server)
      .patch(`/api/v1/document-types/${id}`)
      .set('Authorization', as(subject, amr))
      .set('X-Tenant-Id', tenant)
      .set('If-Match', ifMatch)
      .send(body as object);
  const get = (subject: string, tenant: string, query = '') =>
    request(api.server)
      .get(`/api/v1/document-types${query}`)
      .set('Authorization', as(subject))
      .set('X-Tenant-Id', tenant);

  const body = (overrides: Record<string, unknown> = {}) => ({
    kind: 'FREE_TEXT',
    code: 'PARECER_TECNICO',
    name: 'Parecer técnico',
    allowMultiplePerProcess: true,
    numberingEnabled: true,
    numberingMask: 'PT {seq:3}/{year}',
    requiresApproval: false,
    defaultConfidentiality: 'INTERNAL',
    ...overrides,
  });

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
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

    // Provisionamento (US-099) ainda não existe: a semeadura real, tenant a tenant.
    const facade = api.app.get(DocumentTypeFacade);
    const transaction = api.app.get(TenantTransaction);
    for (const tenantId of [A, B]) {
      await runAsSystem({ name: 'Semeadura de tipos de documento (teste)', tenantId }, () =>
        transaction.run((tx) => facade.seedDefaults(tx)),
      );
    }
    await db.admin(
      `INSERT INTO document_types (id, tenant_id, code, name, kind)
       VALUES ('0192c000-0000-7000-8000-0000000081b1', '${B}', 'PORTARIA', 'Portaria LEAK-B', 'FREE_TEXT')`,
    );
  });

  afterAll(async () => {
    await api.close();
    if (!dbStopped) await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] a semeadura gravou os 11 tipos de sistema em cada tenant', async () => {
    expect(await typesOf(A)).toHaveLength(11);
    expect(await typesOf(B)).toHaveLength(12);
  });

  it('[Sucesso] Marta cria um tipo: tipo, auditoria e evento no banco, só em A', async () => {
    const digestOfB = await digestOf(B);

    const response = await post(MARTA_SUBJECT, A, body());

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.headers.etag).toBe('"1"');
    const created = (response.body as { data: DocumentTypeDto }).data;
    const [row] = await db.admin<Row>('SELECT * FROM document_types WHERE id = $1', [created.id]);
    expect(row).toMatchObject({
      tenant_id: A,
      code: 'PARECER_TECNICO',
      is_system: false,
      is_active: true,
      numbering_mask: 'PT {seq:3}/{year}',
      version: 1,
      created_by_id: MARTA,
    });
    expect(await audits(created.id)).toEqual([
      expect.objectContaining({
        tenant_id: A,
        action: 'document_type.create',
        category: 'CONFIGURATION',
        result: 'SUCCESS',
        actor_user_id: MARTA,
      }),
    ]);
    const published = await events(created.id);
    expect(published).toEqual([
      expect.objectContaining({
        tenant_id: A,
        event_type: 'DocumentTypeChanged',
        routing_key: 'document_type.changed',
        status: 'PENDING',
      }),
    ]);
    expect((published[0]?.payload as { changedFields: string[] }).changedFields).toContain(
      'numberingMask',
    );
    expect(await digestOf(B)).toBe(digestOfB);
  });

  it('[Sucesso] PATCH com If-Match: nova versão, auditoria campo a campo e evento', async () => {
    const [{ id } = { id: '' }] = (await typesOf(A)).filter(
      (row) => row.code === 'PARECER_TECNICO',
    ) as { id: string }[];

    const response = await patch(
      MARTA_SUBJECT,
      A,
      id,
      { name: 'Parecer jurídico', sortOrder: 5 },
      '"1"',
    );

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.headers.etag).toBe('"2"');
    expect((response.body as { data: unknown }).data).toMatchObject({
      name: 'Parecer jurídico',
      version: 2,
      sortOrder: 5,
    });
    const trail = await audits(id);
    expect(trail.map((entry) => entry.action)).toEqual([
      'document_type.create',
      'document_type.update',
    ]);
    expect(trail[1]?.changes).toEqual([
      { path: 'name', old: 'Parecer técnico', new: 'Parecer jurídico' },
      { path: 'sortOrder', old: 0, new: 5 },
    ]);
    expect((await events(id)).map((event) => event.event_type)).toEqual([
      'DocumentTypeChanged',
      'DocumentTypeChanged',
    ]);
  });

  it('[Tenant incorreto] tipo de B → 404 e B intacto; a lista de A não mostra nada de B', async () => {
    const [typeOfB] = (await typesOf(B)).filter((row) => row.code === 'PORTARIA') as {
      id: string;
    }[];
    const digestOfB = await digestOf(B);
    const auditsBefore = await db.admin('SELECT 1 FROM audit_logs WHERE tenant_id = $1', [B]);

    const response = await patch(MARTA_SUBJECT, A, typeOfB?.id ?? '', { name: 'Invadida' }, '"1"');

    expect(response.status).toBe(404);
    expect(problemDetailsSchema.parse(response.body).code).toBe('NOT_FOUND');
    expect(await digestOf(B)).toBe(digestOfB);
    expect(await db.admin('SELECT 1 FROM audit_logs WHERE tenant_id = $1', [B])).toHaveLength(
      auditsBefore.length,
    );

    const list = await get(MARTA_SUBJECT, A, '?includeInactive=true');
    expect(list.status).toBe(200);
    const text = JSON.stringify(list.body);
    for (const canary of ['LEAK-B', 'PORTARIA', B, typeOfB?.id ?? '']) {
      expect(text.includes(canary), `vazou ${canary}`).toBe(false);
    }
    expect((list.body as { data: unknown[] }).data).toHaveLength(12);
    // Cada administrador vê só o seu catálogo.
    const ofB = await get(BETO_SUBJECT, B, '?includeInactive=true');
    expect((ofB.body as { data: DocumentTypeDto[] }).data.map((type) => type.code)).toContain(
      'PORTARIA',
    );
    expect((ofB.body as { data: DocumentTypeDto[] }).data.map((type) => type.code)).not.toContain(
      'PARECER_TECNICO',
    );
  });

  it('[Tenant incorreto] aprovador vinculado só a B → 422 REFERENCE_NOT_FOUND; do próprio tenant sem perfil real → REFERENCE_INACTIVE', async () => {
    const [target] = (await typesOf(A)).filter((row) => row.code === 'DECLARACAO') as {
      id: string;
    }[];
    const attempt = (approverUserId: string) =>
      patch(
        MARTA_SUBJECT,
        A,
        target?.id ?? '',
        {
          requiresApproval: true,
          approvalPolicy: { approverType: 'USER', approverUserId, allowDeputy: true },
        },
        '"1"',
      );

    const other = await attempt(HEITOR);
    expect(other.status).toBe(422);
    expect(problemDetailsSchema.parse(other.body).errors).toEqual([
      expect.objectContaining({
        field: 'approvalPolicy.approverUserId',
        code: 'REFERENCE_NOT_FOUND',
      }),
    ]);
    // Perfis como registro chegam com a US-096: até lá o vínculo real não traz APPROVAL_DECIDE.
    const own = await attempt(LUCIA);
    expect(problemDetailsSchema.parse(own.body).errors).toEqual([
      expect.objectContaining({
        field: 'approvalPolicy.approverUserId',
        code: 'REFERENCE_INACTIVE',
      }),
    ]);
    expect((await typesOf(A)).find((row) => row.code === 'DECLARACAO')?.version).toBe(1);
  });

  it('[Permissão] sem DOCUMENT_TYPE_MANAGE → 403 e access.denied gravado; includeInactive também', async () => {
    const response = await post(LUCIA_SUBJECT, A, body({ code: 'PROIBIDO' }));
    expect(response.status).toBe(403);
    expect(problemDetailsSchema.parse(response.body).code).toBe('PERMISSION_DENIED');
    expect((await typesOf(A)).some((row) => row.code === 'PROIBIDO')).toBe(false);
    const denied = await db.admin<Row>(
      `SELECT tenant_id, result, reason_code, actor_user_id FROM audit_logs
        WHERE action = 'access.denied' AND actor_user_id = $1`,
      [LUCIA],
    );
    expect(denied).toContainEqual(
      expect.objectContaining({
        tenant_id: A,
        result: 'DENIED',
        reason_code: 'DOCUMENT_TYPE_MANAGE',
      }),
    );
    expect((await get(LUCIA_SUBJECT, A)).status).toBe(200);
    expect((await get(LUCIA_SUBJECT, A, '?includeInactive=true')).status).toBe(403);
  });

  it('[Permissão] sessão sem MFA → 403 MFA_REQUIRED e nada persistido', async () => {
    const [target] = (await typesOf(A)).filter((row) => row.code === 'OFICIO') as { id: string }[];
    const response = await patch(MARTA_SUBJECT, A, target?.id ?? '', { name: 'Sem MFA' }, '"1"', [
      'pwd',
    ]);
    expect(response.status).toBe(403);
    expect(problemDetailsSchema.parse(response.body).code).toBe('MFA_REQUIRED');
    expect((await typesOf(A)).find((row) => row.code === 'OFICIO')).toMatchObject({
      name: 'Ofício',
      version: 1,
    });
  });

  it('[Duplicidade] código repetido → 409; criação concorrente do mesmo código → uma 201 e uma 409', async () => {
    const duplicate = await post(MARTA_SUBJECT, A, body());
    expect(duplicate.status).toBe(409);
    expect(problemDetailsSchema.parse(duplicate.body)).toMatchObject({
      code: 'CONFLICT',
      detail: 'Já existe um tipo com o código PARECER_TECNICO.',
    });

    const concurrent = body({ code: 'CERTIDAO', name: 'Certidão' });
    const results = await Promise.all([
      post(MARTA_SUBJECT, A, concurrent),
      post(MARTA_SUBJECT, A, concurrent),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect((await typesOf(A)).filter((row) => row.code === 'CERTIDAO')).toHaveLength(1);
    // O tipo vencedor tem exatamente uma auditoria e um evento; o perdedor não deixou rastro.
    const [winner] = (await typesOf(A)).filter((row) => row.code === 'CERTIDAO') as {
      id: string;
    }[];
    expect(await audits(winner?.id ?? '')).toHaveLength(1);
    expect(await events(winner?.id ?? '')).toHaveLength(1);
    // Mesmo código em outro tenant é permitido.
    expect((await post(BETO_SUBJECT, B, body())).status).toBe(201);
  });

  it('[Concorrência] mesma versão em duas edições: uma 200 e outra 412 VERSION_CONFLICT', async () => {
    const [target] = (await typesOf(A)).filter((row) => row.code === 'AUTORIZACAO') as {
      id: string;
    }[];
    const results = await Promise.all([
      patch(MARTA_SUBJECT, A, target?.id ?? '', { sortOrder: 91 }, '"1"'),
      patch(MARTA_SUBJECT, A, target?.id ?? '', { sortOrder: 92 }, '"1"'),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 412]);
    const loser = results.find((result) => result.status === 412);
    expect(problemDetailsSchema.parse(loser?.body).code).toBe('VERSION_CONFLICT');
    expect((await typesOf(A)).find((row) => row.code === 'AUTORIZACAO')?.version).toBe(2);
    // A edição perdedora não deixou auditoria nem evento próprios.
    expect(await audits(target?.id ?? '')).toHaveLength(1);
    expect(await events(target?.id ?? '')).toHaveLength(1);
  });

  it('[Falha de banco] banco indisponível ao salvar → 503 com Retry-After', async () => {
    dbStopped = true;
    await db.container.stop();
    const response = await post(MARTA_SUBJECT, A, body({ code: 'SEM_BANCO' }));
    expect(response.status).toBe(503);
    expect(problemDetailsSchema.parse(response.body).code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(response.headers['retry-after']).toBeDefined();
  });
});
