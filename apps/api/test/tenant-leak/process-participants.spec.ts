// Participantes do processo sobre PostgreSQL real (US-012 · Sucesso, Tenant incorreto,
// Concorrência, Falha de banco, Falha de integração): a API inteira como `cf_app` (RLS) com os
// seeders reais do provisionamento, o processo criado pelo PRC-02 e os participantes pelos
// PRC-28..32. Prova o índice único parcial sob concessões paralelas (exatamente uma 201), a
// concessão/revogação de `process_access` na mesma transação, a transação única por falha induzida
// DEPOIS de gravar o participante (nada persiste: participante, concessão, timeline, auditoria e
// outbox), o evento `PENDING`, o consultor vencido sem visibilidade antes do job (RN-PROC-135 — o
// predicado SQL e a consulta por id), a RLS, a FK composta da unidade e o gatilho de colunas
// imutáveis. `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { ProcessDto, ProcessParticipantDto } from '@contrataflow/validation';
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

const A = '0192c012-0000-7000-8000-00000000010a';
const B = '0192c012-0000-7000-8000-00000000010b';
const ORG_A = '0192c012-0000-7000-8000-0000000010a0';
const ORG_B = '0192c012-0000-7000-8000-0000000010b0';
const OBRAS = '0192c012-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c012-0000-7000-8000-0000000010a2';
const SAUDE = '0192c012-0000-7000-8000-0000000010a3';
const OBRAS_B = '0192c012-0000-7000-8000-0000000010b1';
const ANA = '0192c012-0000-7000-8000-0000000010c1';
const CARLA = '0192c012-0000-7000-8000-0000000010c2';
const DIEGO = '0192c012-0000-7000-8000-0000000010c3';
const ELISA = '0192c012-0000-7000-8000-0000000010c4';
const BETO = '0192c012-0000-7000-8000-0000000010c5';
const ANA_M = '0192c012-0000-7000-8000-0000000010d1';
const NOW = new Date('2026-10-05T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [CARLA]: ['GESTOR_CONTRATACOES'],
  // Consultor externo: segue processos, mas só vê os em que participa.
  [DIEGO]: ['CONSULTOR_EXTERNO'],
  [ELISA]: ['CONSULTOR_EXTERNO'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const SUBJECTS = {
  ana: 'sub-ana-us012',
  carla: 'sub-carla-us012',
  diego: 'sub-diego-us012',
  elisa: 'sub-elisa-us012',
  beto: 'sub-beto-us012',
} as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us012', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us012', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1),
  ('${SAUDE}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Saúde', '${path(SAUDE)}', 0),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Obras LEAK-B', '${path(OBRAS_B)}', 0);
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', '${SUBJECTS.ana}', 'ana@a.test', true, 'Ana Souza'),
  ('${CARLA}', '${SUBJECTS.carla}', 'carla@a.test', true, 'Carla Dias'),
  ('${DIEGO}', '${SUBJECTS.diego}', 'diego@consultoria.test', true, 'Diego Alves'),
  ('${ELISA}', '${SUBJECTS.elisa}', 'elisa@a.test', true, 'Elisa Melo'),
  ('${BETO}', '${SUBJECTS.beto}', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status, expires_at) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE', NULL),
  ('0192c012-0000-7000-8000-0000000010d2', '${A}', '${CARLA}', 'INTERNAL', 'ACTIVE', NULL),
  ('0192c012-0000-7000-8000-0000000010d3', '${A}', '${DIEGO}', 'EXTERNAL', 'ACTIVE', '2099-12-31T00:00:00Z'),
  ('0192c012-0000-7000-8000-0000000010d4', '${A}', '${ELISA}', 'INTERNAL', 'ACTIVE', NULL),
  ('0192c012-0000-7000-8000-0000000010d5', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE', NULL);
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c012-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
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

describe('Feature: Gerenciar participantes do processo sobre PostgreSQL (US-012)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: { contractingType: string; origin: string };

  const tenantOf = (subject: string): string => (subject === SUBJECTS.beto ? B : A);
  const call = (test: request.Test, subject: string = SUBJECTS.carla) =>
    test
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));
  const create = async (): Promise<ProcessDto> => {
    const response = await call(request(api.server).post('/api/v1/processes'), SUBJECTS.ana)
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
  const add = (
    processId: string,
    body: Record<string, unknown>,
    subject: string = SUBJECTS.carla,
  ) =>
    call(request(api.server).post(`/api/v1/processes/${processId}/participants`), subject)
      .set('Idempotency-Key', randomUUID())
      .send(body);
  const catalogId = async (tenantId: string, type: string, code: string) => {
    const [row] = await db.admin<{ id: string }>(
      'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
      [tenantId, type, code],
    );
    if (!row) throw new Error(`${type}/${code} ausente`);
    return row.id;
  };
  /** Tudo que a participação grava do processo (para provar o rollback). */
  const effects = async (processId: string) => ({
    participants: await db.admin<Row>(
      `SELECT id, user_id, department_id, role::text AS role, revoked_at IS NOT NULL AS revoked
         FROM process_participants WHERE process_id = $1 ORDER BY granted_at, id`,
      [processId],
    ),
    access: await db.admin<Row>(
      `SELECT principal_type::text AS principal_type, user_id, department_id, source_id,
              revoked_at IS NOT NULL AS revoked
         FROM process_access WHERE process_id = $1 AND reason = 'PARTICIPANT' ORDER BY granted_at, id`,
      [processId],
    ),
    timeline: await db.admin<Row>(
      `SELECT type, params FROM process_timeline_entries
        WHERE process_id = $1 AND type LIKE 'PARTICIPANT_%' ORDER BY occurred_at, id`,
      [processId],
    ),
    audit: await db.admin<Row>(
      `SELECT action, metadata FROM audit_logs
        WHERE process_id = $1 AND action LIKE 'process.participant_%' ORDER BY occurred_at, id`,
      [processId],
    ),
    events: await db.admin<Row>(
      `SELECT event_type, payload, status::text FROM outbox_events
        WHERE aggregate_id = $1 AND event_type LIKE 'ProcessParticipant%' ORDER BY occurred_at, id`,
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

  it('[Sucesso] adicionar, seguir e remover: process_access PARTICIPANT concedido/revogado na mesma transação, timeline, auditoria e eventos PENDING', async () => {
    const created = await create();
    const added = await add(created.id, { userId: ELISA, role: 'COLLABORATOR' });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const elisa = (added.body as { data: ProcessParticipantDto }).data;
    const unit = await add(created.id, { departmentId: SAUDE, role: 'OBSERVER' });
    expect(unit.status, JSON.stringify(unit.body)).toBe(201);

    // A colaboradora vê o processo só pela participação.
    const panel = await call(
      request(api.server).get(`/api/v1/processes/${created.id}`),
      SUBJECTS.elisa,
    );
    expect(panel.status, JSON.stringify(panel.body)).toBe(200);

    const removed = await call(
      request(api.server).delete(`/api/v1/process-participants/${elisa.id}`),
    ).send({ revocationReason: 'Parecer entregue' });
    expect(removed.status, JSON.stringify(removed.body)).toBe(204);
    const lost = await call(
      request(api.server).get(`/api/v1/processes/${created.id}`),
      SUBJECTS.elisa,
    );
    expect(lost.status).toBe(404);

    const after = await effects(created.id);
    expect(after.participants).toEqual([
      { id: elisa.id, user_id: ELISA, department_id: null, role: 'COLLABORATOR', revoked: true },
      expect.objectContaining({ department_id: SAUDE, role: 'OBSERVER', revoked: false }),
    ]);
    expect(after.access).toEqual([
      {
        principal_type: 'USER',
        user_id: ELISA,
        department_id: null,
        source_id: elisa.id,
        revoked: true,
      },
      expect.objectContaining({
        principal_type: 'DEPARTMENT',
        department_id: SAUDE,
        revoked: false,
      }),
    ]);
    expect(after.timeline.map((row) => [row.type, (row.params as { name: string }).name])).toEqual([
      ['PARTICIPANT_ADDED', 'Elisa Melo'],
      ['PARTICIPANT_ADDED', 'Secretaria de Saúde'],
      ['PARTICIPANT_REMOVED', 'Elisa Melo'],
    ]);
    expect(after.audit.map((row) => row.action)).toEqual([
      'process.participant_add',
      'process.participant_add',
      'process.participant_remove',
    ]);
    // [Falha de integração] relay fora: os eventos ficam PENDING.
    expect(after.events.map((row) => [row.event_type, row.status])).toEqual([
      ['ProcessParticipantAdded', 'PENDING'],
      ['ProcessParticipantAdded', 'PENDING'],
      ['ProcessParticipantRemoved', 'PENDING'],
    ]);
  });

  it('[Concorrência] 10 concessões paralelas para o mesmo usuário: exatamente uma 201, as demais 409 e um único ativo', async () => {
    const created = await create();
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        add(
          created.id,
          { userId: ELISA, role: 'OBSERVER' },
          index % 2 === 0 ? SUBJECTS.carla : SUBJECTS.ana,
        ).then((response) => response),
      ),
    );
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([201, ...Array<number>(9).fill(409)]);
    for (const response of responses.filter((entry) => entry.status === 409)) {
      expect(problemDetailsSchema.parse(response.body).code).toBe('PARTICIPANT_ALREADY_EXISTS');
    }
    const after = await effects(created.id);
    expect(after.participants.filter((row) => row.revoked === false)).toHaveLength(1);
    expect(after.access.filter((row) => row.revoked === false)).toHaveLength(1);
    expect(after.events).toHaveLength(1);
  });

  it('[Sucesso] consultor vencido perde a visibilidade antes do job (predicado SQL e consulta por id)', async () => {
    const created = await create();
    const added = await add(created.id, {
      userId: DIEGO,
      role: 'CONSULTANT',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const seen = await call(request(api.server).get('/api/v1/processes'), SUBJECTS.diego);
    expect(seen.status, JSON.stringify(seen.body)).toBe(200);
    expect((seen.body as { data: { id: string }[] }).data.map((row) => row.id)).toContain(
      created.id,
    );

    // Vencida no relógio da API (NOW) e, por consequência, no `now()` do banco (predicado SQL).
    await db.admin(
      `UPDATE process_participants SET expires_at = $3::timestamptz - interval '1 day'
        WHERE process_id = $1 AND user_id = $2`,
      [created.id, DIEGO, NOW.toISOString()],
    );
    const listed = await call(request(api.server).get('/api/v1/processes'), SUBJECTS.diego);
    expect((listed.body as { data: { id: string }[] }).data.map((row) => row.id)).not.toContain(
      created.id,
    );
    const byId = await call(
      request(api.server).get(`/api/v1/processes/${created.id}`),
      SUBJECTS.diego,
    );
    expect(byId.status).toBe(404);
    // A concessão continua ativa até o job `participants-expire` (worker) materializar.
    expect((await effects(created.id)).access).toEqual([
      expect.objectContaining({ user_id: DIEGO, revoked: false }),
    ]);
  });

  it('[Falha de banco] falha induzida DEPOIS de gravar o participante desfaz participante, concessão, timeline, auditoria e evento', async () => {
    const created = await create();
    await db.admin(`
      CREATE FUNCTION test_fail_participant_timeline() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.type = 'PARTICIPANT_ADDED' THEN
          RAISE EXCEPTION 'falha induzida no teste';
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_fail_participant_timeline BEFORE INSERT ON process_timeline_entries
        FOR EACH ROW EXECUTE FUNCTION test_fail_participant_timeline();`);
    try {
      const before = await effects(created.id);
      const failed = await add(created.id, { userId: ELISA, role: 'OBSERVER' });
      expect(failed.status).toBe(500);
      expect(await effects(created.id)).toEqual(before);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_participant_timeline ON process_timeline_entries; DROP FUNCTION test_fail_participant_timeline();',
      );
    }
  });

  it('[Tenant incorreto] B não lista nem remove participante de A; usuário de B é REFERENCE_NOT_FOUND; RLS, FK composta, índice único e gatilho', async () => {
    const created = await create();
    const added = await add(created.id, { userId: ELISA, role: 'OBSERVER' });
    const participantId = (added.body as { data: ProcessParticipantDto }).data.id;
    const before = await effects(created.id);

    const listed = await call(
      request(api.server).get(`/api/v1/processes/${created.id}/participants`),
      SUBJECTS.beto,
    );
    expect(problemDetailsSchema.parse(listed.body).code).toBe('PROCESS_NOT_FOUND');
    const removed = await call(
      request(api.server).delete(`/api/v1/process-participants/${participantId}`),
      SUBJECTS.beto,
    );
    expect(removed.status).toBe(404);
    expect(problemDetailsSchema.parse(removed.body).code).toBe('PARTICIPANT_NOT_FOUND');
    expect(await effects(created.id)).toEqual(before);

    const foreign = await add(created.id, { userId: BETO, role: 'OBSERVER' });
    expect(foreign.status).toBe(422);
    expect(
      problemDetailsSchema.parse(foreign.body).errors.map((error) => [error.field, error.code]),
    ).toEqual([['userId', 'REFERENCE_NOT_FOUND']]);
    expect(JSON.stringify(foreign.body)).not.toContain('LEAK-B');

    // RLS: com `app.tenant_id` de B, o participante de A não é visível nem alterável.
    const client = db.client('cf_app');
    try {
      const visible = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$queryRaw<{ count: number }[]>`
            SELECT count(*)::int AS count FROM process_participants WHERE id = ${participantId}::uuid`,
        ),
      );
      expect(visible).toEqual([{ count: 0 }]);
      const updated = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$executeRaw`
            UPDATE process_participants SET revoked_at = now() WHERE id = ${participantId}::uuid`,
        ),
      );
      expect(updated).toBe(0);
    } finally {
      await client.$disconnect();
    }
    // FK composta: participante de A com unidade de B é recusado pelo banco.
    await expect(
      db.admin(
        `INSERT INTO process_participants (id, tenant_id, process_id, department_id, role, granted_by_id)
         VALUES ($1, $2, $3, $4, 'OBSERVER', $5)`,
        [randomUUID(), A, created.id, OBRAS_B, CARLA],
      ),
    ).rejects.toThrow();
    // Índice único parcial: segundo ativo do mesmo usuário é recusado.
    await expect(
      db.admin(
        `INSERT INTO process_participants (id, tenant_id, process_id, user_id, role, granted_by_id)
         VALUES ($1, $2, $3, $4, 'COLLABORATOR', $5)`,
        [randomUUID(), A, created.id, ELISA, CARLA],
      ),
    ).rejects.toThrow(/process_participants_active_user_key/);
    // Checks: consultor sem validade; papel não muda in-place (RN-PROC-129).
    await expect(
      db.admin(
        `INSERT INTO process_participants (id, tenant_id, process_id, user_id, role, granted_by_id)
         VALUES ($1, $2, $3, $4, 'CONSULTANT', $5)`,
        [randomUUID(), A, created.id, DIEGO, CARLA],
      ),
    ).rejects.toThrow(/process_participants_consultant_expires/);
    await expect(
      db.admin(`UPDATE process_participants SET role = 'COLLABORATOR' WHERE id = $1`, [
        participantId,
      ]),
    ).rejects.toThrow(/só a revogação/);
  });
});
