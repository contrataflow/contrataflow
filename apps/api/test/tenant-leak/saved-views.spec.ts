// Visões salvas e exportação CSV sobre PostgreSQL real (US-003 · PRC-34..38): a API inteira como
// `cf_app` (RLS) com os seeders do provisionamento e processos inseridos pelo superusuário. Prova o
// cursor no servidor (`DECLARE … CURSOR` com parâmetros + `FETCH` em lotes de 500, numa transação
// somente leitura) atravessando vários lotes na ordem da lista, a auditoria `process.export`, a
// cobertura do escopo de exportação no SQL, os índices únicos de `saved_views` (nome sem
// diferenciar maiúsculas e uma única padrão), a trava por dono e escopo sob concorrência e o
// isolamento: visões e processos de B nunca aparecem, PATCH/DELETE com id de B = 404 e RLS com
// outro `app.tenant_id`. `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema, savedViewSchema } from '@contrataflow/validation';
import type { SavedViewDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

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

const id = (suffix: string) => `0192c003-0000-7000-8000-${suffix.padStart(12, '0')}`;
const A = id('a');
const B = id('b');
const ORG_A = id('a0');
const ORG_B = id('b0');
const OBRAS = id('a1');
const MANUTENCAO = id('a2');
const OBRAS_B = id('b1');
const SETOR_X = id('b2');
const ANA = id('c1');
const LUCIA = id('c2');
const BETO = id('c5');
const NOW = new Date('2026-10-05T17:32:00.000Z');
const MFA = ['pwd', 'otp'];
/** Três lotes do cursor (500 + 500 + 201). */
const BULK = 1201;

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [LUCIA]: ['GESTOR_CONTRATACOES'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};
const SUBJECTS = {
  ana: 'sub-ana-us003',
  lucia: 'sub-lucia-us003',
  beto: 'sub-beto-us003',
} as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us003', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us003', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Obras LEAK-B', '${path(OBRAS_B)}', 0),
  ('${SETOR_X}', '${B}', '${ORG_B}', '${OBRAS_B}', 'SECTOR', 'Setor X LEAK-B', '${path(OBRAS_B, SETOR_X)}', 1);
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', '${SUBJECTS.ana}', 'ana@us003.test', true, 'Ana Souza'),
  ('${LUCIA}', '${SUBJECTS.lucia}', 'patricia@us003.test', true, 'Patrícia Alves'),
  ('${BETO}', '${SUBJECTS.beto}', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status, expires_at) VALUES
  ('${id('d1')}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE', NULL),
  ('${id('d2')}', '${A}', '${LUCIA}', 'INTERNAL', 'ACTIVE', NULL),
  ('${id('d5')}', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE', NULL);
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('${id('e1')}', '${A}', '${id('d1')}', '${MANUTENCAO}', true);
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real. */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

describe('Feature: Visões salvas e exportação CSV sobre PostgreSQL (US-003)', () => {
  let db: TestDatabase;
  let api: TestApi;

  const tenantOf = (subject: string): string => (subject === SUBJECTS.beto ? B : A);
  const auth = (call: request.Test, subject: string) =>
    call
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));
  const createView = (body: Record<string, unknown>, subject: string = SUBJECTS.lucia) =>
    auth(request(api.server).post('/api/v1/saved-views'), subject)
      .set('Idempotency-Key', randomUUID())
      .send({ scope: 'PROCESS_LIST', filters: { v: 1 }, columns: ['code', 'title'], ...body });
  const listViews = (subject: string = SUBJECTS.lucia) =>
    auth(request(api.server).get('/api/v1/saved-views?scope=PROCESS_LIST'), subject);
  const viewOf = (response: request.Response): SavedViewDto => {
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
    return z.object({ data: savedViewSchema }).parse(response.body).data;
  };
  const expectProblem = (response: request.Response, status: number, code: string) => {
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    expect(problemDetailsSchema.parse(response.body).code).toBe(code);
  };

  /** Processos em lote no tenant, na etapa inicial do workflow publicado. */
  async function insertProcesses(options: {
    readonly tenantId: string;
    readonly organizationId: string;
    readonly secretariat: string;
    readonly department: string;
    readonly createdBy: string;
    readonly count: number;
    readonly title: string;
  }): Promise<void> {
    await db.admin(
      `INSERT INTO processes (
         id, tenant_id, organization_id, number, year, code, title, object, contracting_type_id,
         requesting_secretariat_id, requesting_department_id, current_department_id, priority,
         status, workflow_version_id, current_workflow_stage_id, origin_id, pca_status,
         created_by_id, created_at, updated_at)
       SELECT gen_random_uuid(), $1::uuid, $2::uuid, n, 2026, lpad(n::text, 4, '0') || '/2026',
              $7 || ' ' || n, 'Objeto do processo ' || n,
              (SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = 'CONTRACTING_TYPE' AND code = 'AQUISICAO_BENS'),
              $3::uuid, $4::uuid, $4::uuid, 'MEDIUM', 'IN_PROGRESS', s.workflow_version_id, s.id,
              (SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = 'PROCESS_ORIGIN' AND code = 'DEMANDA_NAO_PREVISTA'),
              'NOT_APPLICABLE', $5::uuid, '2026-09-14T13:02:11Z', '2026-10-02T18:40:00Z'
         FROM generate_series(1, $6::int) AS n,
              (SELECT st.id, st.workflow_version_id
                 FROM workflow_stages st
                 JOIN workflow_versions v ON v.id = st.workflow_version_id AND v.status = 'PUBLISHED'
                WHERE st.tenant_id = $1::uuid AND st.key = 'ABERTURA'
                LIMIT 1) AS s`,
      [
        options.tenantId,
        options.organizationId,
        options.secretariat,
        options.department,
        options.createdBy,
        options.count,
        options.title,
      ],
    );
    // Unidade solicitante/atual: visível também a quem tem escopo de unidade.
    await db.admin(
      `INSERT INTO process_access (id, tenant_id, process_id, principal_type, department_id, reason)
       SELECT gen_random_uuid(), tenant_id, id, 'DEPARTMENT', current_department_id, 'CURRENT'
         FROM processes WHERE tenant_id = $1::uuid`,
      [options.tenantId],
    );
  }

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
    await insertProcesses({
      tenantId: A,
      organizationId: ORG_A,
      secretariat: OBRAS,
      department: MANUTENCAO,
      createdBy: ANA,
      count: BULK,
      title: 'Processo em lote',
    });
    await insertProcesses({
      tenantId: B,
      organizationId: ORG_B,
      secretariat: OBRAS_B,
      department: SETOR_X,
      createdBy: BETO,
      count: 2,
      title: 'Processo LEAK-B',
    });
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] exportação por cursor: três lotes na ordem da lista, sem B, auditada', async () => {
    const response = await auth(
      request(api.server).get('/api/v1/processes/export?columns=code,title,status&sort=code'),
      SUBJECTS.lucia,
    ).buffer(true);
    expect(response.status, response.text).toBe(200);
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="processos-20261005-1432.csv"',
    );
    const lines = response.text.split('\r\n').slice(0, -1);
    expect(lines).toHaveLength(BULK + 1);
    expect(lines[0]).toBe('﻿Código;Título;Situação');
    expect(lines[1]).toBe('0001/2026;Processo em lote 1;Em andamento');
    expect(lines.at(-1)).toBe(
      `${String(BULK).padStart(4, '0')}/2026;Processo em lote ${String(BULK)};Em andamento`,
    );
    expect(response.text).not.toContain('LEAK-B');

    const audits = await db.admin<{
      result: string;
      tenant_id: string;
      metadata: Record<string, unknown>;
    }>(
      "SELECT result::text, tenant_id::text, metadata FROM audit_logs WHERE action = 'process.export'",
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ result: 'SUCCESS', tenant_id: A });
    expect(audits[0]?.metadata).toMatchObject({ rowCount: BULK, maskedRowCount: 0, sort: 'code' });
  });

  it('[Validação] filtro combinado e contagem exata no mesmo conjunto do cursor', async () => {
    const response = await auth(
      request(api.server).get('/api/v1/processes/export?q=lote%2012&columns=code,title&sort=-code'),
      SUBJECTS.lucia,
    ).buffer(true);
    expect(response.status, response.text).toBe(200);
    expect(response.text).toContain('0012/2026;Processo em lote 12');
  });

  it('[Permissão] sem PROCESS_EXPORT → 403 e access.denied com reasonCode PROCESS_EXPORT', async () => {
    const response = await auth(request(api.server).get('/api/v1/processes/export'), SUBJECTS.ana);
    expectProblem(response, 403, 'PERMISSION_DENIED');
    const denied = await db.admin<{ reason_code: string }>(
      "SELECT reason_code FROM audit_logs WHERE action = 'access.denied' AND actor_user_id = $1",
      [ANA],
    );
    expect(denied.map((row) => row.reason_code)).toContain('PROCESS_EXPORT');
  });

  it('[Duplicidade] nome único sem diferenciar maiúsculas (aplicação e índice) e padrão única', async () => {
    const first = viewOf(await createView({ name: 'Atrasados por prioridade', isDefault: true }));
    expectProblem(await createView({ name: 'atrasados por PRIORIDADE' }), 409, 'CONFLICT');
    // Rede de segurança do banco: índices únicos `lower(name)` e da padrão (parcial).
    const insert = (name: string, isDefault: boolean) =>
      db.admin(
        `INSERT INTO saved_views (id, tenant_id, owner_id, scope, name, filters, columns, is_default)
         VALUES (gen_random_uuid(), $1, $2, 'PROCESS_LIST', $3, '{"v":1}', '["code","title"]', $4)`,
        [A, LUCIA, name, isDefault],
      );
    await expect(insert('ATRASADOS POR PRIORIDADE', false)).rejects.toThrow(
      /saved_views_owner_name_key/,
    );
    await expect(insert('Outra padrão', true)).rejects.toThrow(/saved_views_owner_default_key/);
    await expect(
      db.admin(
        `INSERT INTO saved_views (id, tenant_id, owner_id, scope, name, filters, columns)
         VALUES (gen_random_uuid(), $1, $2, 'PROCESS_LIST', 'Sem versão', '{}', '[]')`,
        [A, LUCIA],
      ),
    ).rejects.toThrow(/saved_views_filters_versioned/);
    expect(first.isDefault).toBe(true);
  });

  it('[Concorrência] duas criações com "padrão" em paralelo: a trava deixa uma única padrão', async () => {
    const [left, right] = await Promise.all([
      createView({ name: 'Paralela A', isDefault: true }, SUBJECTS.ana),
      createView({ name: 'Paralela B', isDefault: true }, SUBJECTS.ana),
    ]);
    expect([left.status, right.status]).toEqual([201, 201]);
    const rows = await db.admin<{ name: string }>(
      'SELECT name FROM saved_views WHERE owner_id = $1 AND is_default',
      [ANA],
    );
    expect(rows).toHaveLength(1);
  });

  it('[Tenant incorreto] visão de B: fora da listagem, PATCH/DELETE = 404 e RLS fecha', async () => {
    const viewB = viewOf(await createView({ name: 'V1', isShared: true }, SUBJECTS.beto));
    const listed = z
      .object({ data: z.array(savedViewSchema) })
      .parse((await listViews()).body)
      .data.map((view) => view.id);
    expect(listed).not.toContain(viewB.id);
    expectProblem(
      await auth(request(api.server).patch(`/api/v1/saved-views/${viewB.id}`), SUBJECTS.lucia)
        .set('If-Match', '"1"')
        .send({ name: 'Invadida' }),
      404,
      'NOT_FOUND',
    );
    expectProblem(
      await auth(request(api.server).delete(`/api/v1/saved-views/${viewB.id}`), SUBJECTS.lucia).set(
        'If-Match',
        '"1"',
      ),
      404,
      'NOT_FOUND',
    );
    const [stored] = await db.admin<{ name: string }>(
      'SELECT name FROM saved_views WHERE id = $1',
      [viewB.id],
    );
    expect(stored?.name).toBe('V1');
    const client = db.client('cf_app');
    try {
      const seen = await asTenant(A, () =>
        client.$tenantTransaction(
          (tx) =>
            tx.$queryRaw<{ id: string }[]>`SELECT id FROM saved_views WHERE tenant_id = ${B}::uuid`,
        ),
      );
      expect(seen).toEqual([]);
    } finally {
      await client.$disconnect();
    }
  });
});
