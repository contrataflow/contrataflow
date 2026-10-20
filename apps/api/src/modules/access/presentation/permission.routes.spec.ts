import { PERMISSIONS } from '@contrataflow/types';
import { permissionSchema, problemDetailsSchema } from '@contrataflow/validation';
import type { PermissionDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { CACHE_STORE } from '#shared/cache/cache-store.js';
import type { InMemoryCacheStore } from '#shared/cache/cache-store.js';
import { runAsSystem } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { AccessFacade } from '../application/access.facade.js';
import { DEFAULT_ROLES } from '../domain/default-roles.js';
import { InMemoryRoleRepository } from '../infrastructure/in-memory-role.repository.js';

/*
 * US-094 — ROL-01 pelo pipeline HTTP completo (autenticação, tenant, vínculo, validação Zod,
 * filtro RFC 9457) com a identidade fake, e o seeder `access.defaultRoles` com a auditoria real do
 * `AuditService` (store em memória). Os mesmos casos contra o PostgreSQL (migração do catálogo,
 * RLS, idempotência, concorrência e rollback) estão em `test/access` e `test/tenant-leak`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const MARTA = FAKE_USERS.marta; // ADMIN_ORGAO (a "Ana" do Gherkin)
const ANA = FAKE_USERS.ana; // REQUISITANTE: sem ROLE_VIEW (o "Bruno" do Gherkin)
const HEITOR = FAKE_USERS.heitor; // vínculo só na Prefeitura B
const PROVISIONED = '0192a000-0000-7000-8000-000000000094';

function dataOf(response: request.Response): PermissionDto[] {
  return (response.body as { data: PermissionDto[] }).data;
}

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  expect(problemDetailsSchema.parse(response.body).code).toBe(code);
}

describe('Feature: Catálogo de permissões e perfis padrão (US-094)', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await createTestApi();
  });
  afterAll(async () => {
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    vi.restoreAllMocks();
  });

  const list = (user: { subject: string } = MARTA, query = '', tenant = A) =>
    request(api.server)
      .get(`/api/v1/permissions${query}`)
      .set('Authorization', api.bearer(user.subject))
      .set('X-Tenant-Id', tenant);

  it('[Sucesso] Consultar o catálogo: 200 com as 69 permissões e todos os campos', async () => {
    const response = await list();
    expect(response.status).toBe(200);
    const data = dataOf(response);
    expect(data).toHaveLength(69);
    for (const permission of data) expect(permissionSchema.strict().parse(permission)).toBeTruthy();
    expect(data).toEqual(PERMISSIONS.map((permission) => ({ ...permission })));
    expect(data.find((permission) => permission.code === 'ROLE_VIEW')).toEqual({
      code: 'ROLE_VIEW',
      module: 'access',
      name: 'Visualizar perfis',
      description: expect.any(String) as string,
      riskLevel: 'LOW',
      scopable: false,
      isDeprecated: false,
      introducedIn: 'MVP1',
    });
  });

  it('FA-02 — filtros module e riskLevel retornam só o subconjunto', async () => {
    const access = dataOf(await list(MARTA, '?module=access'));
    expect(access.map((permission) => permission.code)).toEqual([
      'ROLE_VIEW',
      'ROLE_MANAGE',
      'ROLE_ASSIGN',
    ]);
    const high = dataOf(await list(MARTA, '?riskLevel=HIGH'));
    expect(high.length).toBeGreaterThan(0);
    expect(high.every((permission) => permission.riskLevel === 'HIGH')).toBe(true);
    const both = dataOf(await list(MARTA, '?module=access&riskLevel=HIGH'));
    expect(both.map((permission) => permission.code)).toEqual(['ROLE_MANAGE', 'ROLE_ASSIGN']);
  });

  it('[Validação] filtro com valor desconhecido é ignorado: lista completa de 69', async () => {
    const response = await list(MARTA, '?riskLevel=EXTREME&module=nada&page=2');
    expect(response.status).toBe(200);
    expect(dataOf(response)).toHaveLength(69);
    expect(dataOf(await list(MARTA, '?riskLevel=LOW&riskLevel=HIGH'))).toHaveLength(69);
  });

  it('[Permissão] usuário sem ROLE_VIEW → 403 PERMISSION_DENIED, auditado como access.denied', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const denials = api.auditRecords().filter((r) => r.action === 'access.denied').length;
    expectProblem(await list(ANA), 403, 'PERMISSION_DENIED');
    const records = api.auditRecords().filter((r) => r.action === 'access.denied');
    expect(records).toHaveLength(denials + 1);
    expect(records.at(-1)).toMatchObject({ reasonCode: 'ROLE_VIEW' });
  });

  it('[Tenant incorreto] usuário sem vínculo no tenant → 403 MEMBERSHIP_INACTIVE', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expectProblem(await list(HEITOR, '', A), 403, 'MEMBERSHIP_INACTIVE');
  });

  it('[Falha de integração] Redis indisponível: 200 normalmente (o catálogo não depende de cache)', async () => {
    const cache = api.app.get<InMemoryCacheStore>(CACHE_STORE, { strict: false });
    const down = () => Promise.reject(new Error('redis indisponível'));
    vi.spyOn(cache, 'get').mockImplementation(down);
    vi.spyOn(cache, 'set').mockImplementation(down);
    vi.spyOn(cache, 'delete').mockImplementation(down);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const response = await list();
    expect(response.status).toBe(200);
    expect(dataOf(response)).toHaveLength(69);
  });

  it('[Sucesso] seeder pela fachada: 15 perfis e role.create com ator SYSTEM na auditoria real', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const facade = api.app.get(AccessFacade, { strict: false });
    const result = await runAsSystem(
      { name: 'Provisionamento do tenant', tenantId: PROVISIONED },
      () => runSimulatedTransaction((tx) => facade.seedDefaultRoles(tx)),
    );
    const total = DEFAULT_ROLES.reduce((sum, role) => sum + role.permissions.length, 0);
    expect(result).toEqual({ rolesCreated: 15, permissionsGranted: total });

    const repository = api.app.get(InMemoryRoleRepository, { strict: false });
    expect(repository.rolesOfTenant(PROVISIONED)).toHaveLength(15);
    const audits = api
      .auditRecords()
      .filter((record) => record.action === 'role.create' && record.tenantId === PROVISIONED);
    expect(audits).toHaveLength(15);
    for (const record of audits) {
      expect(record).toMatchObject({
        actorType: 'SYSTEM',
        actorUserId: null,
        category: 'SECURITY',
        entityType: 'Role',
        metadata: expect.objectContaining({ isSystem: true, seeded: true }) as unknown,
      });
    }
  });
});
