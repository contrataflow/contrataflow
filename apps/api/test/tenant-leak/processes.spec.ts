// Criação de processo sobre PostgreSQL real (US-001 · Sucesso, Tenant incorreto, Duplicidade,
// Concorrência, Falha de banco, Falha de integração): a API inteira como `cf_app` (RLS) com os
// seeders reais do provisionamento (catálogos, perfis, tipos de documento, workflow padrão DEC-015),
// numeração por sequência transacional, timeline e `ProcessAccess` projetados no mesmo `tx`,
// auditoria e outbox (`PENDING` — o relay não roda aqui). Prova a transação única por falha
// induzida DEPOIS de numerar (nada persiste e o número não é consumido), 50 criações simultâneas
// sem repetição nem lacuna, a heurística de duplicidade com `pg_trgm`, a RLS e as FKs compostas
// das tabelas do processo e a imutabilidade da tramitação. Perfis do vínculo por porta de teste.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { DuplicateCandidate, ProcessDto } from '@contrataflow/validation';
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

const A = '0192c000-0000-7000-8000-00000000010a';
const B = '0192c000-0000-7000-8000-00000000010b';
const ORG_A = '0192c000-0000-7000-8000-0000000010a0';
const ORG_B = '0192c000-0000-7000-8000-0000000010b0';
const OBRAS = '0192c000-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c000-0000-7000-8000-0000000010a2';
const SAUDE = '0192c000-0000-7000-8000-0000000010a3';
const POSTO = '0192c000-0000-7000-8000-0000000010a4';
const OBRAS_B = '0192c000-0000-7000-8000-0000000010b1';
const SETOR_X = '0192c000-0000-7000-8000-0000000010b2';
const ANA = '0192c000-0000-7000-8000-0000000010c1';
const LUCIA = '0192c000-0000-7000-8000-0000000010c2';
const BETO = '0192c000-0000-7000-8000-0000000010c3';
const ANA_M = '0192c000-0000-7000-8000-0000000010d1';
const NOW = new Date('2026-10-16T13:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [LUCIA]: ['GESTOR_CONTRATACOES'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us001', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us001', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1),
  ('${SAUDE}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Saúde', '${path(SAUDE)}', 0),
  ('${POSTO}', '${A}', '${ORG_A}', '${SAUDE}', 'SECTOR', 'Posto Central', '${path(SAUDE, POSTO)}', 1),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Obras LEAK-B', '${path(OBRAS_B)}', 0),
  ('${SETOR_X}', '${B}', '${ORG_B}', '${OBRAS_B}', 'SECTOR', 'Setor X LEAK-B', '${path(OBRAS_B, SETOR_X)}', 1);
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', 'sub-ana-us001', 'ana@a.test', true, 'Ana Souza'),
  ('${LUCIA}', 'sub-lucia-us001', 'lucia@a.test', true, 'Lúcia Matos'),
  ('${BETO}', 'sub-beto-us001', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000010d2', '${A}', '${LUCIA}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c000-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
INSERT INTO number_sequences (id, tenant_id, sequence_key, last_value) VALUES
  ('0192c000-0000-7000-8000-0000000010f1', '${A}', 'PROCESS:*:2026', 11);
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

describe('Feature: Criar processo de contratação sobre PostgreSQL (US-001)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: { contractingType: string; origin: string };

  const tenantOf = (subject: string) => (subject === 'sub-beto-us001' ? B : A);
  const body = (overrides: Record<string, unknown> = {}) => ({
    title: `Compra ${words(2)}`,
    object: `Objeto ${words(3)}`,
    contractingTypeId: catalog.contractingType,
    requestingSecretariatId: OBRAS,
    requestingDepartmentId: MANUTENCAO,
    originId: catalog.origin,
    pcaStatus: 'NOT_APPLICABLE',
    ...overrides,
  });
  const post = (
    payload: unknown,
    subject = 'sub-ana-us001',
    headers: Readonly<Record<string, string>> = {},
  ) => {
    let call = request(api.server)
      .post('/api/v1/processes')
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject))
      .set('Idempotency-Key', randomUUID());
    for (const [name, value] of Object.entries(headers)) call = call.set(name, value);
    return call.send(payload as object);
  };
  const catalogId = async (tenantId: string, type: string, code: string) => {
    const [row] = await db.admin<{ id: string }>(
      'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
      [tenantId, type, code],
    );
    if (!row) throw new Error(`${type}/${code} ausente`);
    return row.id;
  };
  const lastValue = async () => {
    const [row] = await db.admin<{ last_value: number }>(
      "SELECT last_value FROM number_sequences WHERE tenant_id = $1 AND sequence_key = 'PROCESS:*:2026'",
      [A],
    );
    return row?.last_value ?? 0;
  };
  const count = async (table: string, tenantId = A) => {
    const [row] = await db.admin<{ count: string }>(
      `SELECT count(*) FROM ${table} WHERE tenant_id = $1`,
      [tenantId],
    );
    return Number(row?.count ?? 0);
  };
  const totals = async () => ({
    processes: await count('processes'),
    stages: await count('process_stages'),
    assignments: await count('process_assignments'),
    movements: await count('process_movements'),
    access: await count('process_access'),
    timeline: await count('process_timeline_entries'),
    audit: Number(
      (
        await db.admin<{ count: string }>(
          "SELECT count(*) FROM audit_logs WHERE tenant_id = $1 AND action = 'process.create'",
          [A],
        )
      )[0]?.count ?? 0,
    ),
    events: Number(
      (
        await db.admin<{ count: string }>(
          "SELECT count(*) FROM outbox_events WHERE tenant_id = $1 AND event_type = 'ProcessCreated'",
          [A],
        )
      )[0]?.count ?? 0,
    ),
    sequence: await lastValue(),
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
      DATABASE_POOL_SIZE: '20',
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

  let created: ProcessDto;

  it('[Sucesso] 0012/2026 em DRAFT na ABERTURA com Ana; passagem, tramitação, acessos, timeline, auditoria e evento PENDING no mesmo commit', async () => {
    const response = await post(body({ title: 'Aquisição de cimento para manutenção de vias' }));

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    created = (response.body as { data: ProcessDto }).data;
    expect(response.headers.etag).toBe('"1"');
    expect(created).toMatchObject({
      code: '0012/2026',
      number: 12,
      status: 'DRAFT',
      currentStage: { key: 'ABERTURA', name: 'Formalização da demanda' },
      currentDepartment: { id: MANUTENCAO, name: 'Setor de Manutenção' },
      currentResponsible: { id: ANA, name: 'Ana Souza' },
      workflow: { name: 'Fase preparatória — Lei 14.133/2021', versionNumber: 1 },
    });

    const [process] = await db.admin<Row>(
      `SELECT status, number, year, code, opened_at IS NOT NULL AS opened, current_stage_id,
              current_responsible_id, workflow_version_id, created_by_id,
              search_vector @@ plainto_tsquery('portuguese', cf_unaccent('manutencao')) AS searchable
         FROM processes WHERE id = $1`,
      [created.id],
    );
    expect(process).toMatchObject({
      status: 'DRAFT',
      number: 12,
      year: 2026,
      code: '0012/2026',
      opened: true,
      current_stage_id: created.currentStage?.id,
      current_responsible_id: ANA,
      created_by_id: ANA,
      searchable: true,
    });
    const [published] = await db.admin<{ status: string }>(
      'SELECT status FROM workflow_versions WHERE id = $1',
      [process?.workflow_version_id],
    );
    expect(published?.status).toBe('PUBLISHED');
    expect(
      await db.admin<Row>(
        'SELECT sequence, status::text, department_id, assignee_id, sla_days FROM process_stages WHERE process_id = $1',
        [created.id],
      ),
    ).toEqual([
      { sequence: 1, status: 'ACTIVE', department_id: MANUTENCAO, assignee_id: ANA, sla_days: 5 },
    ]);
    expect(
      await db.admin<Row>(
        'SELECT type::text, assignee_id, is_active FROM process_assignments WHERE process_id = $1',
        [created.id],
      ),
    ).toEqual([{ type: 'STAGE_ENTRY', assignee_id: ANA, is_active: true }]);
    const [movement] = await db.admin<Row>(
      `SELECT sequence, action::text, actor_id, host(ip) AS ip, correlation_id, status_to::text
         FROM process_movements WHERE process_id = $1`,
      [created.id],
    );
    expect(movement).toMatchObject({
      sequence: 1,
      action: 'CREATE',
      actor_id: ANA,
      status_to: 'DRAFT',
      ip: expect.any(String) as unknown,
      correlation_id: expect.any(String) as unknown,
    });
    expect(
      await db.admin<Row>(
        `SELECT reason::text, coalesce(department_id, user_id) AS principal FROM process_access
          WHERE process_id = $1 ORDER BY reason, principal`,
        [created.id],
      ),
    ).toEqual(
      [
        { reason: 'CREATOR', principal: ANA },
        { reason: 'CURRENT', principal: MANUTENCAO },
        { reason: 'REQUESTING', principal: OBRAS },
        { reason: 'REQUESTING', principal: MANUTENCAO },
        { reason: 'RESPONSIBLE', principal: ANA },
      ].sort((a, b) =>
        a.reason === b.reason
          ? a.principal.localeCompare(b.principal)
          : a.reason.localeCompare(b.reason),
      ),
    );
    expect(
      await db.admin<Row>(
        'SELECT type, params FROM process_timeline_entries WHERE process_id = $1',
        [created.id],
      ),
    ).toEqual([
      {
        type: 'PROCESS_CREATED',
        params: {
          code: '0012/2026',
          title: 'Aquisição de cimento para manutenção de vias',
          requestingDepartmentName: 'Setor de Manutenção',
        },
      },
    ]);
    const [audit] = await db.admin<Row>(
      "SELECT category::text, metadata FROM audit_logs WHERE tenant_id = $1 AND action = 'process.create' AND entity_id = $2",
      [A, created.id],
    );
    expect(audit).toMatchObject({
      category: 'DATA_CHANGE',
      metadata: expect.objectContaining({
        code: '0012/2026',
        initialStageKey: 'ABERTURA',
      }) as unknown,
    });
    // [Falha de integração] relay fora: o evento fica PENDING até ser publicado (uma vez).
    expect(
      await db.admin<Row>(
        'SELECT routing_key, status::text FROM outbox_events WHERE tenant_id = $1 AND aggregate_id = $2',
        [A, created.id],
      ),
    ).toEqual([{ routing_key: 'process.created', status: 'PENDING' }]);

    // PRC-04: a criadora vê; o tenant B não (404 igual ao inexistente).
    const own = await request(api.server)
      .get(`/api/v1/processes/${created.id}`)
      .set('Authorization', api.bearer('sub-ana-us001', { amr: MFA }))
      .set('X-Tenant-Id', A);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    const other = await request(api.server)
      .get(`/api/v1/processes/${created.id}`)
      .set('Authorization', api.bearer('sub-beto-us001', { amr: MFA }))
      .set('X-Tenant-Id', B);
    expect(other.status).toBe(404);
    expect(problemDetailsSchema.parse(other.body).code).toBe('PROCESS_NOT_FOUND');
  });

  it('[Tenant incorreto] unidade de B no corpo: 422 REFERENCE_NOT_FOUND e nada de B lido ou alterado', async () => {
    const before = await totals();
    const response = await post(
      body({ requestingSecretariatId: OBRAS_B, requestingDepartmentId: SETOR_X }),
      'sub-lucia-us001',
    );
    expect(response.status).toBe(422);
    const problem = problemDetailsSchema.parse(response.body);
    expect(problem.errors.map((error) => [error.field, error.code])).toEqual([
      ['requestingSecretariatId', 'REFERENCE_NOT_FOUND'],
      ['requestingDepartmentId', 'REFERENCE_NOT_FOUND'],
    ]);
    expect(JSON.stringify(response.body)).not.toContain('LEAK-B');
    expect(await totals()).toEqual(before);
    expect(await count('processes', B)).toBe(0);
  });

  it('[Tenant incorreto] RLS: o tenant B não lê nenhuma linha do processo de A; a FK composta recusa unidade de B', async () => {
    const client = db.client('cf_app');
    try {
      const seen = await asTenant(B, () =>
        client.$tenantTransaction(async (tx) => ({
          processes: await tx.$queryRaw<Row[]>`SELECT id FROM processes`,
          stages: await tx.$queryRaw<Row[]>`SELECT id FROM process_stages`,
          movements: await tx.$queryRaw<Row[]>`SELECT id FROM process_movements`,
          access: await tx.$queryRaw<Row[]>`SELECT id FROM process_access`,
          assignments: await tx.$queryRaw<Row[]>`SELECT id FROM process_assignments`,
        })),
      );
      expect(seen).toEqual({
        processes: [],
        stages: [],
        movements: [],
        access: [],
        assignments: [],
      });
      // Concessão de A apontando para a unidade de B: a FK (tenant_id, department_id) recusa.
      const crossTenant = asTenant(A, () =>
        client.$tenantTransaction(
          (tx) => tx.$executeRaw`
            INSERT INTO process_access (id, tenant_id, process_id, principal_type, department_id, reason)
            VALUES (${randomUUID()}::uuid, ${A}::uuid, ${created.id}::uuid, 'DEPARTMENT', ${SETOR_X}::uuid, 'PARTICIPANT')`,
        ),
      );
      await expect(crossTenant).rejects.toThrow();
      // Tramitação é registro histórico: a aplicação nem tem UPDATE e o gatilho barra até o dono.
      const tamper = asTenant(A, () =>
        client.$tenantTransaction(
          (tx) =>
            tx.$executeRaw`UPDATE process_movements SET comment = 'x' WHERE process_id = ${created.id}::uuid`,
        ),
      );
      await expect(tamper).rejects.toThrow(/permission denied/);
      await expect(
        db.admin("UPDATE process_movements SET comment = 'x' WHERE process_id = $1", [created.id]),
      ).rejects.toThrow(/imutável/);
      // A versão do workflow fixada na criação é imutável (RN-PROC-06).
      await expect(
        db.admin(
          `UPDATE processes SET workflow_version_id = (
             SELECT id FROM workflow_versions WHERE tenant_id = $2 AND id <> workflow_version_id LIMIT 1)
           WHERE id = $1`,
          [created.id, A],
        ),
      ).rejects.toThrow(/imutáveis/);
    } finally {
      await client.$disconnect();
    }
  });

  it('[Duplicidade] pg_trgm: título semelhante da mesma criadora → 409 com o candidato; PRC-03 lista; "Criar mesmo assim" numera 13', async () => {
    const check = await request(api.server)
      .post('/api/v1/processes/check-duplicates')
      .set('Authorization', api.bearer('sub-ana-us001', { amr: MFA }))
      .set('X-Tenant-Id', A)
      .send({
        title: 'Aquisição de cimento p/ manutenção das vias',
        object: `Objeto ${words(3)}`,
        requestingDepartmentId: MANUTENCAO,
      });
    expect(check.status, JSON.stringify(check.body)).toBe(200);
    expect(
      (check.body as { data: { candidates: DuplicateCandidate[] } }).data.candidates.map(
        (candidate) => [candidate.code, candidate.createdBy.name],
      ),
    ).toEqual([['0012/2026', 'Ana Souza']]);

    const duplicate = body({ title: 'Aquisição de cimento p/ manutenção das vias' });
    const blocked = await post(duplicate);
    expect(blocked.status).toBe(409);
    expect(problemDetailsSchema.parse(blocked.body).code).toBe('POSSIBLE_DUPLICATE_PROCESS');
    const confirmed = await post({ ...duplicate, confirmDuplicate: true });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);
    expect((confirmed.body as { data: ProcessDto }).data.code).toBe('0013/2026');

    // Código interno único no tenant (índice parcial).
    expect((await post(body({ internalCode: 'PROT-2026-0457' }))).status).toBe(201);
    const taken = await post(body({ internalCode: 'PROT-2026-0457' }));
    expect(problemDetailsSchema.parse(taken.body).code).toBe('DUPLICATE_INTERNAL_CODE');
  });

  it('[Concorrência] rollback não consome número: falha induzida DEPOIS de numerar desfaz tudo e o próximo recebe o mesmo número', async () => {
    // Falha no INSERT da tramitação (depois do número, do processo e da passagem).
    await db.admin(`
      CREATE FUNCTION test_fail_movement() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.correlation_id = 'us001-falha-induzida' THEN
          RAISE EXCEPTION 'falha induzida no teste';
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_fail_movement BEFORE INSERT ON process_movements
        FOR EACH ROW EXECUTE FUNCTION test_fail_movement();`);
    try {
      const before = await totals();
      const failed = await post(body(), 'sub-ana-us001', {
        'X-Correlation-Id': 'us001-falha-induzida',
      });
      expect(failed.status).toBe(500);
      expect(await totals()).toEqual(before);
      const next = await post(body());
      expect(next.status, JSON.stringify(next.body)).toBe(201);
      expect((next.body as { data: ProcessDto }).data.number).toBe(before.sequence + 1);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_movement ON process_movements; DROP FUNCTION test_fail_movement();',
      );
    }
  });

  it('[Concorrência] 50 criações simultâneas: números distintos e sem lacunas, uma etapa ativa cada', async () => {
    const start = await lastValue();
    const responses = await Promise.all(
      Array.from({ length: 50 }, () =>
        post(body(), 'sub-lucia-us001').then((response) => response),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual(Array(50).fill(201));
    const numbers = responses
      .map((response) => (response.body as { data: ProcessDto }).data.number ?? 0)
      .sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 50 }, (_, index) => start + index + 1));
    const [stages] = await db.admin<{ processes: string; active: string }>(
      `SELECT count(DISTINCT process_id) AS processes, count(*) FILTER (WHERE status = 'ACTIVE') AS active
         FROM process_stages WHERE tenant_id = $1`,
      [A],
    );
    expect(Number(stages?.active)).toBe(Number(stages?.processes));
  });
});
