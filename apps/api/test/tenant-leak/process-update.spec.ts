// Edição dos dados do processo sobre PostgreSQL real (US-005 · Sucesso, Tenant incorreto,
// Concorrência, Falha de banco, Falha de integração): a API inteira como `cf_app` (RLS) com os
// seeders reais do provisionamento, o processo criado pelo PRC-02 e a edição pelo PRC-05. Prova a
// transação única por falha induzida DEPOIS de gravar o processo (nada persiste: processo, acessos,
// timeline, auditoria e outbox), a troca da unidade solicitante revogando/concedendo `ProcessAccess`,
// o `SELECT … FOR UPDATE` serializando o PATCH com um encaminhamento concorrente, duas edições com o
// mesmo `If-Match` (uma 200, outra 412), a timeline `BUDGET_RESTRICTED` de processo sigiloso, o
// evento `PENDING` e a RLS (processo de outro tenant = 404, sem alterar nada).
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { ProcessDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
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

const A = '0192c005-0000-7000-8000-00000000010a';
const B = '0192c005-0000-7000-8000-00000000010b';
const ORG_A = '0192c005-0000-7000-8000-0000000010a0';
const ORG_B = '0192c005-0000-7000-8000-0000000010b0';
const OBRAS = '0192c005-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c005-0000-7000-8000-0000000010a2';
const PAVIMENTACAO = '0192c005-0000-7000-8000-0000000010a3';
const OBRAS_B = '0192c005-0000-7000-8000-0000000010b1';
const SETOR_X = '0192c005-0000-7000-8000-0000000010b2';
const ANA = '0192c005-0000-7000-8000-0000000010c1';
const LUCIA = '0192c005-0000-7000-8000-0000000010c2';
const BETO = '0192c005-0000-7000-8000-0000000010c3';
const ANA_M = '0192c005-0000-7000-8000-0000000010d1';
const NOW = new Date('2026-10-05T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [LUCIA]: ['GESTOR_CONTRATACOES'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us005', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us005', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1),
  ('${PAVIMENTACAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Pavimentação', '${path(OBRAS, PAVIMENTACAO)}', 1),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Obras LEAK-B', '${path(OBRAS_B)}', 0),
  ('${SETOR_X}', '${B}', '${ORG_B}', '${OBRAS_B}', 'SECTOR', 'Setor X LEAK-B', '${path(OBRAS_B, SETOR_X)}', 1);
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', 'sub-ana-us005', 'ana@a.test', true, 'Ana Souza'),
  ('${LUCIA}', 'sub-lucia-us005', 'lucia@a.test', true, 'Lúcia Matos'),
  ('${BETO}', 'sub-beto-us005', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c005-0000-7000-8000-0000000010d2', '${A}', '${LUCIA}', 'INTERNAL', 'ACTIVE'),
  ('0192c005-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c005-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true),
  ('0192c005-0000-7000-8000-0000000010e2', '${A}', '${ANA_M}', '${PAVIMENTACAO}', false);
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

describe('Feature: Editar dados do processo sobre PostgreSQL (US-005)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: { contractingType: string; origin: string };

  const tenantOf = (subject: string) => (subject === 'sub-beto-us005' ? B : A);
  const create = async (): Promise<ProcessDto> => {
    const response = await request(api.server)
      .post('/api/v1/processes')
      .set('Authorization', api.bearer('sub-ana-us005', { amr: MFA }))
      .set('X-Tenant-Id', A)
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
    return (response.body as { data: ProcessDto }).data;
  };
  const patch = (
    id: string,
    payload: Record<string, unknown>,
    ifMatch: number,
    subject = 'sub-ana-us005',
    headers: Readonly<Record<string, string>> = {},
  ) => {
    let call = request(api.server)
      .patch(`/api/v1/processes/${id}`)
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject))
      .set('If-Match', `"${String(ifMatch)}"`);
    for (const [name, value] of Object.entries(headers)) call = call.set(name, value);
    return call.send(payload);
  };
  const catalogId = async (tenantId: string, type: string, code: string) => {
    const [row] = await db.admin<{ id: string }>(
      'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
      [tenantId, type, code],
    );
    if (!row) throw new Error(`${type}/${code} ausente`);
    return row.id;
  };
  const processRow = async (id: string) =>
    (
      await db.admin<Row>(
        `SELECT version, priority::text, description, requesting_department_id,
                current_department_id, current_responsible_id, updated_by_id, workflow_version_id
           FROM processes WHERE id = $1`,
        [id],
      )
    )[0];
  /** Tudo que a edição grava do processo (para provar o rollback). */
  const effects = async (id: string) => ({
    process: await processRow(id),
    access: await db.admin<Row>(
      `SELECT reason::text, department_id, user_id, revoked_at IS NOT NULL AS revoked
         FROM process_access WHERE process_id = $1 ORDER BY reason, department_id, user_id`,
      [id],
    ),
    timeline: await db.admin<Row>(
      "SELECT params FROM process_timeline_entries WHERE process_id = $1 AND type = 'PROCESS_UPDATED'",
      [id],
    ),
    audit: await db.admin<Row>(
      "SELECT metadata FROM audit_logs WHERE entity_id = $1 AND action = 'process.update'",
      [id],
    ),
    events: await db.admin<Row>(
      "SELECT payload, status::text FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'ProcessUpdated'",
      [id],
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

  it('[Sucesso] troca do setor solicitante em rascunho: REQUESTING revogado/concedido, timeline, auditoria e evento PENDING no mesmo commit', async () => {
    const created = await create();
    const response = await patch(
      created.id,
      { requestingDepartmentId: PAVIMENTACAO, priority: 'HIGH' },
      1,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.headers.etag).toBe('"2"');

    const after = await effects(created.id);
    expect(after.process).toMatchObject({
      version: 2,
      priority: 'HIGH',
      requesting_department_id: PAVIMENTACAO,
      current_department_id: MANUTENCAO,
      current_responsible_id: ANA,
      updated_by_id: ANA,
    });
    const requesting = after.access.filter((row) => row.reason === 'REQUESTING');
    expect(requesting).toEqual(
      expect.arrayContaining([
        { reason: 'REQUESTING', department_id: MANUTENCAO, user_id: null, revoked: true },
        { reason: 'REQUESTING', department_id: PAVIMENTACAO, user_id: null, revoked: false },
        { reason: 'REQUESTING', department_id: OBRAS, user_id: null, revoked: false },
      ]),
    );
    expect(requesting).toHaveLength(3);
    // A unidade atual segue com a concessão CURRENT (a custódia não muda).
    expect(after.access).toContainEqual({
      reason: 'CURRENT',
      department_id: MANUTENCAO,
      user_id: null,
      revoked: false,
    });
    expect(after.timeline).toEqual([
      { params: { fields: ['requestingDepartmentId', 'priority'] } },
    ]);
    expect(after.audit).toEqual([
      {
        metadata: expect.objectContaining({
          version: 2,
          requestingAccessChanged: true,
        }) as unknown,
      },
    ]);
    // [Falha de integração] relay fora: o evento fica PENDING, sem valores no payload.
    expect(after.events).toEqual([
      {
        payload: { changedFields: ['requestingDepartmentId', 'priority'], version: 2 },
        status: 'PENDING',
      },
    ]);
  });

  it('[Falha de banco] falha induzida DEPOIS de gravar o processo desfaz processo, acessos, timeline, auditoria e evento', async () => {
    const created = await create();
    await db.admin(`
      CREATE FUNCTION test_fail_update_timeline() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.type = 'PROCESS_UPDATED' AND NEW.params::text LIKE '%description%' THEN
          RAISE EXCEPTION 'falha induzida no teste';
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_fail_update_timeline BEFORE INSERT ON process_timeline_entries
        FOR EACH ROW EXECUTE FUNCTION test_fail_update_timeline();`);
    try {
      const before = await effects(created.id);
      const failed = await patch(
        created.id,
        { description: 'Descrição nova do processo', requestingDepartmentId: PAVIMENTACAO },
        1,
      );
      expect(failed.status).toBe(500);
      expect(await effects(created.id)).toEqual(before);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_update_timeline ON process_timeline_entries; DROP FUNCTION test_fail_update_timeline();',
      );
    }
  });

  it('[Concorrência] FOR UPDATE: PATCH espera o encaminhamento concorrente e é recusado com 403 NOT_PROCESS_CUSTODIAN', async () => {
    const created = await create();
    const client = db.client('cf_app');
    try {
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => {
        locked = resolve;
      });
      // "Encaminhamento": trava o processo, troca o responsável e a versão e segura o commit.
      const forward = asTenant(A, () =>
        client.$tenantTransaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM processes WHERE id = ${created.id}::uuid FOR UPDATE`;
          await tx.$executeRaw`
            UPDATE processes SET current_responsible_id = ${LUCIA}::uuid, version = version + 1
             WHERE id = ${created.id}::uuid`;
          locked();
          await tx.$executeRaw`SELECT pg_sleep(1)`;
        }),
      );
      await lockTaken;
      // If-Match = versão DEPOIS do encaminhamento: só a espera pela trava explica o 403.
      const response = await patch(created.id, { priority: 'URGENT' }, 2);
      await forward;
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(problemDetailsSchema.parse(response.body).code).toBe('NOT_PROCESS_CUSTODIAN');
      expect(await processRow(created.id)).toMatchObject({ version: 2, priority: 'MEDIUM' });
      const [denied] = await db.admin<Row>(
        "SELECT reason_code FROM audit_logs WHERE tenant_id = $1 AND action = 'access.denied' ORDER BY occurred_at DESC LIMIT 1",
        [A],
      );
      expect(denied).toEqual({ reason_code: 'NOT_PROCESS_CUSTODIAN' });
    } finally {
      await client.$disconnect();
    }
  });

  it('[Concorrência] duas edições com o mesmo If-Match: uma 200, a outra 412 com currentVersion', async () => {
    const created = await create();
    const responses = await Promise.all([
      patch(created.id, { priority: 'HIGH' }, 1),
      patch(created.id, { priority: 'LOW' }, 1),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 412]);
    const conflict = responses.find((response) => response.status === 412);
    expect(conflict?.body).toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: 2 });
    expect((await processRow(created.id))?.version).toBe(2);
    expect((await effects(created.id)).events).toHaveLength(1);
  });

  it('[Sucesso] valor estimado de processo sigiloso: timeline BUDGET_RESTRICTED', async () => {
    const created = await create();
    await db.admin('UPDATE processes SET is_budget_confidential = true WHERE id = $1', [
      created.id,
    ]);
    const response = await patch(created.id, { estimatedValue: '120000.00' }, 1);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(
      await db.admin<Row>(
        "SELECT visibility::text FROM process_timeline_entries WHERE process_id = $1 AND type = 'PROCESS_UPDATED'",
        [created.id],
      ),
    ).toEqual([{ visibility: 'BUDGET_RESTRICTED' }]);
  });

  it('[Tenant incorreto] processo de A pelo tenant B: 404 PROCESS_NOT_FOUND e nada alterado', async () => {
    const created = await create();
    const before = await effects(created.id);
    const response = await patch(created.id, { priority: 'HIGH' }, 1, 'sub-beto-us005');
    expect(response.status).toBe(404);
    expect(problemDetailsSchema.parse(response.body).code).toBe('PROCESS_NOT_FOUND');
    expect(await effects(created.id)).toEqual(before);
    // Unidade de B no corpo: inexistente para A.
    const foreign = await patch(
      created.id,
      { requestingSecretariatId: OBRAS_B, requestingDepartmentId: SETOR_X },
      1,
    );
    expect(foreign.status).toBe(422);
    expect(
      problemDetailsSchema.parse(foreign.body).errors.map((error) => [error.field, error.code]),
    ).toEqual([
      ['requestingSecretariatId', 'REFERENCE_NOT_FOUND'],
      ['requestingDepartmentId', 'REFERENCE_NOT_FOUND'],
    ]);
    expect(JSON.stringify(foreign.body)).not.toContain('LEAK-B');
  });
});
