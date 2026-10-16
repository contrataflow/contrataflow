import { problemDetailsSchema } from '@contrataflow/validation';
import type {
  MembershipDetailMeta,
  TenantMembershipDetailDto,
  TenantMembershipDto,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { CACHE_STORE } from '#shared/cache/cache-store.js';
import type { CacheStore } from '#shared/cache/cache-store.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  assignDepartment,
  assignRole,
  seedDefaultRolesOf,
  seedDepartment,
  seedOrganizations,
} from '../../../../test/support/structure-fixtures.js';
import {
  IDENTITY_CLOCK,
  IDENTITY_REPOSITORY,
  IDENTITY_TENANT_TRANSACTIONS,
} from '../application/ports.js';
import type { IdentityTenantTransactions } from '../application/ports.js';
import type { InMemoryIdentityRepository } from '../infrastructure/in-memory-identity.repositories.js';

/*
 * US-092 — USR-01/07..12 pelo pipeline HTTP completo (autenticação, tenant, vínculo, MFA,
 * If-Match, validação Zod, filtro RFC 9457) com a identidade fake, a auditoria real do
 * `AuditService`, o outbox e o cache em memória. Os mesmos fluxos contra o PostgreSQL (RLS,
 * substituição atômica da lotação, trava do POL-12 sob concorrência) estão em
 * `test/tenant-leak/memberships.spec.ts`.
 *
 * Elenco do Gherkin no diretório fake (tenant A = "Prefeitura de São José"): Carla = Marta
 * (`ADMIN_ORGAO`), Diego = Eva (sem perfil), Elisa = Lúcia (`GESTOR_CONTRATACOES`, só
 * `USER_VIEW`), Fábio = Heitor (só no tenant B).
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const CARLA = FAKE_USERS.marta;
const OTAVIO = FAKE_USERS.otavio;
const DIEGO = FAKE_USERS.eva;
const ELISA = FAKE_USERS.lucia;
const FABIO = FAKE_USERS.heitor;
/** Vínculo `SUSPENDED` do diretório fake. */
const BRUNO = FAKE_USERS.bruno;
/** Vínculo `EXTERNAL` com validade vencida (2026-01-01). */
const EXTERNA = FAKE_USERS.carla;
/** Só `REQUISITANTE`: sem `USER_VIEW`. */
const ANA = FAKE_USERS.ana;
const MFA = ['pwd', 'otp'];
const DAY = 24 * 3_600_000;

const PMSJ = newId();
const ORG_B = newId();
const COMPRAS = newId();
const LICITACOES = newId();
const SETOR_INATIVO = newId();
const SETOR_B = newId();

const now = new Date('2026-10-15T12:00:00.000Z');

/** Transações simuladas com falha injetável (banco fora do ar). */
class ToggleTransactions implements IdentityTenantTransactions {
  failRun = false;

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.failRun) return Promise.reject(new DatabaseUnavailableError(new Error('down')));
    return runSimulatedTransaction(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }
}

interface Detail {
  readonly data: TenantMembershipDetailDto;
  readonly meta: MembershipDetailMeta;
}

function detailOf(response: request.Response): Detail {
  return response.body as Detail;
}

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

describe('Feature: Gerenciar usuários e lotações (US-092)', () => {
  let api: TestApi;
  let identity: InMemoryIdentityRepository;
  let cache: CacheStore;
  const transactions = new ToggleTransactions();
  let adminRoleId: string;

  const membershipIdOf = (userId: string, tenantId = A): string => {
    const membership = identity.membershipOf(userId, tenantId);
    if (!membership) throw new Error('vínculo do diretório fake não encontrado');
    return membership.id;
  };

  beforeAll(async () => {
    api = await createTestApi({
      providers: [
        { token: IDENTITY_CLOCK, value: () => now },
        { token: IDENTITY_TENANT_TRANSACTIONS, value: transactions },
      ],
    });
    identity = api.app.get<InMemoryIdentityRepository>(IDENTITY_REPOSITORY, { strict: false });
    cache = api.app.get<CacheStore>(CACHE_STORE, { strict: false });
    // Background: "Prefeitura de São José" ativa; Diego lotado no "Setor de Compras".
    seedOrganizations(
      api,
      { tenantId: A, id: PMSJ, shortName: 'PMSJ', cnpj: '11222333000181' },
      { tenantId: B, id: ORG_B, shortName: 'PMB', cnpj: '33000167000101' },
    );
    seedDepartment(api, { tenantId: A, id: COMPRAS, organizationId: PMSJ, name: 'Compras' });
    seedDepartment(api, {
      tenantId: A,
      id: LICITACOES,
      organizationId: PMSJ,
      name: 'Setor de Licitações',
    });
    seedDepartment(api, {
      tenantId: A,
      id: SETOR_INATIVO,
      organizationId: PMSJ,
      name: 'Setor desativado',
      isActive: false,
    });
    seedDepartment(api, { tenantId: B, id: SETOR_B, organizationId: ORG_B, name: 'Setor de B' });
    assignDepartment(api, membershipIdOf(DIEGO.id), COMPRAS);
    const roles = seedDefaultRolesOf(api, A);
    seedDefaultRolesOf(api, B);
    const admin = roles.get('ADMIN_ORGAO');
    if (!admin) throw new Error('ADMIN_ORGAO não semeado');
    adminRoleId = admin.id;
    // Carla é a administradora do tenant (`role_assignments`); Otávio age com `USER_MANAGE` sem
    // a atribuição do `ADMIN_ORGAO` gravada — como quem tem um perfil personalizado com a
    // permissão. Assim, Carla é a última administradora ativa (POL-12).
    assignRole(api, { tenantId: A, membershipId: membershipIdOf(CARLA.id), roleId: adminRoleId });
  });
  afterAll(async () => {
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    transactions.failRun = false;
    vi.restoreAllMocks();
  });

  const silence = () => ({
    log: vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
    warn: vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
    error: vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
  });

  const as = (test: request.Test, user: { subject: string | null } = CARLA, tenant = A) =>
    test
      .set('Authorization', api.bearer(user.subject ?? '', { amr: MFA }))
      .set('X-Tenant-Id', tenant);
  const getUser = (userId: string, user: { subject: string | null } = CARLA) =>
    as(request(api.server).get(`/api/v1/users/${userId}`), user);
  const patchUser = (
    userId: string,
    body: Record<string, unknown>,
    version: number,
    user: { subject: string | null } = CARLA,
  ) =>
    as(request(api.server).patch(`/api/v1/users/${userId}`), user)
      .set('If-Match', `"${String(version)}"`)
      .send(body);
  const putDepartments = (userId: string, body: Record<string, unknown>, version: number) =>
    as(request(api.server).put(`/api/v1/users/${userId}/departments`))
      .set('If-Match', `"${String(version)}"`)
      .send(body);
  const post = (
    action: 'suspend' | 'reactivate' | 'revoke',
    userId: string,
    version: number,
    body: Record<string, unknown> = {},
    user: { subject: string | null } = CARLA,
  ) =>
    as(request(api.server).post(`/api/v1/users/${userId}/${action}`), user)
      .set('If-Match', `"${String(version)}"`)
      .send(body);

  const auditOf = (action: string) => api.auditRecords().filter((r) => r.action === action);
  const eventsOf = (eventType: string) => api.outboxRows().filter((r) => r.eventType === eventType);

  async function versionOf(userId: string): Promise<number> {
    const response = await getUser(userId);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return detailOf(response).data.version;
  }

  describe('[Sucesso] Atualizar cargo e lotação de um usuário', () => {
    it('edita cargo e move a lotação principal, com evento, auditoria, ETag e cache invalidado', async () => {
      const logger = silence();
      const deleted = vi.spyOn(cache, 'delete');
      const detail = await getUser(DIEGO.id);
      expect(detail.status, JSON.stringify(detail.body)).toBe(200);
      const before = detailOf(detail);
      expect(detail.headers.etag).toBe(`"${String(before.data.version)}"`);
      expect(before.data).toMatchObject({
        userId: DIEGO.id,
        name: DIEGO.name,
        status: 'ACTIVE',
        departmentIds: [COMPRAS],
        primaryDepartmentId: COMPRAS,
        departments: [{ id: COMPRAS, name: 'Compras', isActive: true, isPrimary: true }],
      });
      expect(before.meta).toEqual({
        allowedActions: ['UPDATE', 'UPDATE_DEPARTMENTS', 'SUSPEND', 'REVOKE'],
        isSelf: false,
      });

      const patched = await patchUser(
        DIEGO.id,
        { jobTitle: '  Coordenador de Compras ', registrationNumber: 'M-1020' },
        before.data.version,
      );
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
      const afterPatch = detailOf(patched);
      expect(afterPatch.data).toMatchObject({
        jobTitle: 'Coordenador de Compras',
        registrationNumber: 'M-1020',
        version: before.data.version + 1,
      });
      expect(patched.headers.etag).toBe(`"${String(before.data.version + 1)}"`);
      expect(auditOf('membership.update').at(-1)).toMatchObject({
        tenantId: A,
        category: 'SECURITY',
        entityId: before.data.id,
        actorUserId: CARLA.id,
        changes: [
          { path: 'jobTitle', old: null, new: 'Coordenador de Compras' },
          { path: 'registrationNumber', old: null, new: 'M-1020' },
        ],
      });
      expect(eventsOf('MembershipUpdated').at(-1)).toMatchObject({
        routingKey: 'membership.updated',
        aggregateId: before.data.id,
        payload: {
          membershipId: before.data.id,
          changedFields: ['jobTitle', 'registrationNumber'],
        },
      });

      const moved = await putDepartments(
        DIEGO.id,
        { departmentIds: [COMPRAS, LICITACOES], primaryDepartmentId: LICITACOES },
        afterPatch.data.version,
      );
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      expect(detailOf(moved).data).toMatchObject({
        departmentIds: [LICITACOES, COMPRAS],
        primaryDepartmentId: LICITACOES,
        departments: [
          { id: LICITACOES, name: 'Setor de Licitações', isPrimary: true },
          { id: COMPRAS, name: 'Compras', isPrimary: false },
        ],
        version: afterPatch.data.version + 1,
      });
      expect(eventsOf('MembershipUpdated').at(-1)).toMatchObject({
        payload: { membershipId: before.data.id, changedFields: ['departments'] },
      });
      expect(auditOf('membership.departments_update').at(-1)).toMatchObject({
        category: 'SECURITY',
        entityId: before.data.id,
        changes: [
          {
            path: 'departments',
            old: { departmentIds: [COMPRAS], primaryDepartmentId: COMPRAS },
            new: { departmentIds: [LICITACOES, COMPRAS], primaryDepartmentId: LICITACOES },
          },
        ],
      });
      // RN-IAM-61: o cache de permissões efetivas de Diego cai já no commit.
      const invalidated = deleted.mock.calls.filter(([key]) =>
        key.endsWith(`:t:${A}:access:eff:${before.data.id}`),
      );
      expect(invalidated).toHaveLength(2);
      expect(logger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'membership.mutation',
          action: 'departments_update',
          membershipId: before.data.id,
        }),
        'membership.mutation',
      );
    });

    it('mesma lotação ou mesmos dados: 200 sem nova versão, evento ou auditoria', async () => {
      const version = await versionOf(DIEGO.id);
      const events = eventsOf('MembershipUpdated').length;
      const same = await putDepartments(
        DIEGO.id,
        { departmentIds: [COMPRAS, LICITACOES], primaryDepartmentId: LICITACOES },
        version,
      );
      expect(same.status, JSON.stringify(same.body)).toBe(200);
      const unchanged = await patchUser(DIEGO.id, { jobTitle: 'Coordenador de Compras' }, version);
      expect(unchanged.status).toBe(200);
      expect(detailOf(unchanged).data.version).toBe(version);
      expect(eventsOf('MembershipUpdated')).toHaveLength(events);
    });

    it('FA-01: a validade do vínculo EXTERNAL é editável dentro do limite', async () => {
      const version = await versionOf(EXTERNA.id);
      const expiresAt = new Date(now.getTime() + 90 * DAY).toISOString();
      const response = await patchUser(EXTERNA.id, { expiresAt }, version);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(detailOf(response).data.expiresAt).toBe(expiresAt);
      expect(eventsOf('MembershipUpdated').at(-1)).toMatchObject({
        payload: { changedFields: ['expiresAt'] },
      });
    });
  });

  describe('[Validação] Campos e lotações', () => {
    it('remover todas as lotações → 422 REQUIRED em departmentIds, sem gravar', async () => {
      const version = await versionOf(DIEGO.id);
      const response = await putDepartments(
        DIEGO.id,
        { departmentIds: [], primaryDepartmentId: COMPRAS },
        version,
      );
      const body = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(body.errors).toContainEqual(
        expect.objectContaining({
          field: 'departmentIds',
          code: 'REQUIRED',
          message: 'Selecione ao menos uma lotação.',
        }),
      );
      expect(await versionOf(DIEGO.id)).toBe(version);
    });

    it('V-03/V-05: unidade inativa, de outro tenant ou principal fora da lista', async () => {
      const version = await versionOf(DIEGO.id);
      const inactive = expectProblem(
        await putDepartments(
          DIEGO.id,
          { departmentIds: [SETOR_INATIVO], primaryDepartmentId: SETOR_INATIVO },
          version,
        ),
        422,
        'VALIDATION_ERROR',
      );
      expect(inactive.errors).toEqual([
        expect.objectContaining({ field: 'departmentIds', code: 'REFERENCE_INACTIVE' }),
      ]);
      const otherTenant = expectProblem(
        await putDepartments(
          DIEGO.id,
          { departmentIds: [SETOR_B], primaryDepartmentId: SETOR_B },
          version,
        ),
        422,
        'VALIDATION_ERROR',
      );
      expect(otherTenant.errors).toEqual([
        expect.objectContaining({
          field: 'departmentIds',
          code: 'REFERENCE_NOT_FOUND',
          message: 'Selecione uma lotação válida.',
        }),
      ]);
      const primary = expectProblem(
        await putDepartments(
          DIEGO.id,
          { departmentIds: [COMPRAS], primaryDepartmentId: LICITACOES },
          version,
        ),
        422,
        'VALIDATION_ERROR',
      );
      expect(primary.errors).toContainEqual(
        expect.objectContaining({ field: 'primaryDepartmentId', code: 'INVALID_ENUM' }),
      );
    });

    it('V-01/V-02: limites de texto e validade (só EXTERNAL, dentro do intervalo)', async () => {
      const version = await versionOf(DIEGO.id);
      const tooLong = expectProblem(
        await patchUser(DIEGO.id, { jobTitle: 'x'.repeat(151) }, version),
        422,
        'VALIDATION_ERROR',
      );
      expect(tooLong.errors).toContainEqual(
        expect.objectContaining({
          field: 'jobTitle',
          code: 'TOO_LONG',
          message: 'O cargo deve ter no máximo 150 caracteres.',
        }),
      );
      const internal = expectProblem(
        await patchUser(DIEGO.id, { expiresAt: '2026-12-01T00:00:00.000Z' }, version),
        422,
        'VALIDATION_ERROR',
      );
      expect(internal.errors).toContainEqual(
        expect.objectContaining({ field: 'expiresAt', code: 'NOT_ALLOWED' }),
      );
      const externalVersion = await versionOf(EXTERNA.id);
      const tooFar = expectProblem(
        await patchUser(
          EXTERNA.id,
          { expiresAt: new Date(now.getTime() + 181 * DAY).toISOString() },
          externalVersion,
        ),
        422,
        'VALIDATION_ERROR',
      );
      expect(tooFar.errors).toContainEqual(
        expect.objectContaining({
          field: 'expiresAt',
          code: 'OUT_OF_RANGE',
          message: 'Informe uma validade entre hoje e 180 dias.',
        }),
      );
      const past = expectProblem(
        await patchUser(EXTERNA.id, { expiresAt: '2026-10-01T00:00:00.000Z' }, externalVersion),
        422,
        'VALIDATION_ERROR',
      );
      expect(past.errors).toContainEqual(
        expect.objectContaining({ field: 'expiresAt', code: 'OUT_OF_RANGE' }),
      );
      const reason = expectProblem(
        await post('suspend', DIEGO.id, version, { reason: 'x'.repeat(501) }),
        422,
        'VALIDATION_ERROR',
      );
      expect(reason.errors).toContainEqual(
        expect.objectContaining({ field: 'reason', code: 'TOO_LONG' }),
      );
    });

    it('sem If-Match → 428 PRECONDITION_REQUIRED', async () => {
      const response = await as(request(api.server).post(`/api/v1/users/${DIEGO.id}/suspend`)).send(
        {},
      );
      expectProblem(response, 428, 'PRECONDITION_REQUIRED');
    });
  });

  describe('[Permissão] Usuário sem USER_MANAGE', () => {
    it('Elisa (só USER_VIEW) consulta sem ações e não suspende: 403 e access.denied USER_MANAGE', async () => {
      silence();
      const detail = await getUser(DIEGO.id, ELISA);
      expect(detail.status, JSON.stringify(detail.body)).toBe(200);
      expect(detailOf(detail).meta.allowedActions).toEqual([]);
      const version = detailOf(detail).data.version;
      const events = eventsOf('MembershipSuspended').length;
      const denied = await post('suspend', DIEGO.id, version, {}, ELISA);
      expectProblem(denied, 403, 'PERMISSION_DENIED');
      expect(auditOf('access.denied').at(-1)).toMatchObject({
        actorUserId: ELISA.id,
        result: 'DENIED',
        reasonCode: 'USER_MANAGE',
      });
      expect(eventsOf('MembershipSuspended')).toHaveLength(events);
      expectProblem(
        await patchUser(DIEGO.id, { jobTitle: 'Outro' }, version, ELISA),
        403,
        'PERMISSION_DENIED',
      );
    });

    it('sem USER_VIEW: lista e detalhe → 403', async () => {
      silence();
      expectProblem(
        await as(request(api.server).get('/api/v1/users'), ANA),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(await getUser(DIEGO.id, ANA), 403, 'PERMISSION_DENIED');
    });

    it('USER_MANAGE é risco alto: sem segundo fator → 403 MFA_REQUIRED', async () => {
      silence();
      const version = await versionOf(DIEGO.id);
      const response = await request(api.server)
        .patch(`/api/v1/users/${DIEGO.id}`)
        .set('Authorization', api.bearer(CARLA.subject, { amr: ['pwd'] }))
        .set('X-Tenant-Id', A)
        .set('If-Match', `"${String(version)}"`)
        .send({ jobTitle: 'Sem MFA' });
      expectProblem(response, 403, 'MFA_REQUIRED');
    });
  });

  describe('[Tenant incorreto] Usuário de outro tenant', () => {
    it('Fábio só tem vínculo no tenant B: 404 USER_NOT_FOUND sem revelar nada', async () => {
      silence();
      const response = await getUser(FABIO.id);
      const body = expectProblem(response, 404, 'USER_NOT_FOUND');
      expect(JSON.stringify(body)).not.toContain(FABIO.name);
      expect(JSON.stringify(body)).not.toContain(B);
      expectProblem(await post('suspend', FABIO.id, 1), 404, 'USER_NOT_FOUND');
      expectProblem(await patchUser(FABIO.id, { jobTitle: 'X' }, 1), 404, 'USER_NOT_FOUND');
      expectProblem(
        await putDepartments(
          FABIO.id,
          { departmentIds: [SETOR_B], primaryDepartmentId: SETOR_B },
          1,
        ),
        404,
        'USER_NOT_FOUND',
      );
      expect(identity.membershipOf(FABIO.id, B)?.status).toBe('ACTIVE');
    });
  });

  describe('[Duplicidade] Suspender vínculo já suspenso', () => {
    it('409 INVALID_STATE e nenhum MembershipSuspended novo', async () => {
      silence();
      const version = await versionOf(BRUNO.id);
      const events = eventsOf('MembershipSuspended').length;
      const response = await post('suspend', BRUNO.id, version);
      const body = expectProblem(response, 409, 'INVALID_STATE');
      expect(body.detail).toBe('Esta ação não é válida para o status atual do vínculo.');
      expect(eventsOf('MembershipSuspended')).toHaveLength(events);
    });
  });

  describe('[Concorrência] Edição simultânea do mesmo vínculo', () => {
    it('a segunda gravação com a mesma version recebe 412 VERSION_CONFLICT', async () => {
      silence();
      const version = await versionOf(DIEGO.id);
      const [first, second] = await Promise.all([
        putDepartments(
          DIEGO.id,
          { departmentIds: [COMPRAS], primaryDepartmentId: COMPRAS },
          version,
        ),
        putDepartments(
          DIEGO.id,
          { departmentIds: [LICITACOES], primaryDepartmentId: LICITACOES },
          version,
        ),
      ]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 412]);
      const loser = first.status === 412 ? first : second;
      expectProblem(loser, 412, 'VERSION_CONFLICT');
      expect(await versionOf(DIEGO.id)).toBe(version + 1);
    });
  });

  describe('[Falha de banco] Banco indisponível ao revogar', () => {
    it('503 DEPENDENCY_UNAVAILABLE, vínculo no status anterior e log membership.mutation_failed', async () => {
      const logger = silence();
      const version = await versionOf(DIEGO.id);
      transactions.failRun = true;
      const response = await post('revoke', DIEGO.id, version, { reason: 'Exonerado' });
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'membership.mutation_failed',
          action: 'revoke',
          errorCode: 'DEPENDENCY_UNAVAILABLE',
        }),
        'membership.mutation_failed',
      );
      transactions.failRun = false;
      expect(identity.membershipOf(DIEGO.id, A)?.status).toBe('ACTIVE');
    });
  });

  describe('[Falha de integração] Redis indisponível ao invalidar cache', () => {
    it('suspende no banco, registra warn access.cache_invalidation_failed e reativa depois', async () => {
      const logger = silence();
      const failing = vi.spyOn(cache, 'delete').mockRejectedValue(new Error('ECONNREFUSED'));
      const version = await versionOf(DIEGO.id);
      const response = await post('suspend', DIEGO.id, version, { reason: 'Afastamento' });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const suspended = detailOf(response);
      expect(suspended.data).toMatchObject({
        status: 'SUSPENDED',
        suspendedAt: now.toISOString(),
        suspensionReason: 'Afastamento',
      });
      expect(suspended.meta.allowedActions).toEqual([
        'UPDATE',
        'UPDATE_DEPARTMENTS',
        'REACTIVATE',
        'REVOKE',
      ]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'access.cache_invalidation_failed',
          membershipId: suspended.data.id,
        }),
        'access.cache_invalidation_failed',
      );
      // O motivo fica só no vínculo: nem o evento nem a auditoria o carregam.
      expect(eventsOf('MembershipSuspended').at(-1)).toMatchObject({
        routingKey: 'membership.suspended',
        payload: { membershipId: suspended.data.id, hasReason: true },
      });
      expect(auditOf('membership.suspend').at(-1)).toMatchObject({
        changes: [{ path: 'status', old: 'ACTIVE', new: 'SUSPENDED' }],
        metadata: { hasReason: true },
      });
      expect(JSON.stringify(auditOf('membership.suspend').at(-1))).not.toContain('Afastamento');
      // A permissão é recalculada do banco: o guard de vínculo (DEC-132) já lê SUSPENDED.
      expect((await identity.findByUserAndTenant(DIEGO.id, A))?.status).toBe('SUSPENDED');

      // Reativar (USR-11) limpa a suspensão.
      failing.mockResolvedValue(undefined);
      const reactivated = await post('reactivate', DIEGO.id, suspended.data.version);
      expect(reactivated.status, JSON.stringify(reactivated.body)).toBe(200);
      expect(detailOf(reactivated).data).toMatchObject({
        status: 'ACTIVE',
        suspendedAt: null,
        suspensionReason: null,
      });
      expect(eventsOf('MembershipReactivated').at(-1)).toMatchObject({
        routingKey: 'membership.reactivated',
        payload: { membershipId: suspended.data.id },
      });
      expect(auditOf('membership.reactivate').at(-1)).toMatchObject({
        changes: [{ path: 'status', old: 'SUSPENDED', new: 'ACTIVE' }],
      });
      expectProblem(
        await post('reactivate', DIEGO.id, detailOf(reactivated).data.version),
        409,
        'INVALID_STATE',
      );
    });
  });

  describe('POL-16 — autoproteção', () => {
    it('Carla não suspende nem revoga o próprio vínculo (403, access.denied POL-16)', async () => {
      silence();
      const own = await getUser(CARLA.id);
      expect(detailOf(own).meta).toEqual({
        allowedActions: ['UPDATE', 'UPDATE_DEPARTMENTS'],
        isSelf: true,
      });
      const version = detailOf(own).data.version;
      const suspend = expectProblem(
        await post('suspend', CARLA.id, version),
        403,
        'PERMISSION_DENIED',
      );
      expect(suspend.detail).toBe('Você não pode remover o próprio acesso.');
      expect(auditOf('access.denied').at(-1)).toMatchObject({
        actorUserId: CARLA.id,
        reasonCode: 'POL-16',
      });
      expectProblem(await post('revoke', CARLA.id, version), 403, 'PERMISSION_DENIED');
      expect(identity.membershipOf(CARLA.id, A)?.status).toBe('ACTIVE');
    });
  });

  describe('POL-12 — anti-bloqueio', () => {
    it('suspender ou revogar a última ADMIN_ORGAO ativa → 409 LAST_ADMIN_REQUIRED', async () => {
      silence();
      const version = await versionOf(CARLA.id);
      const events = eventsOf('MembershipSuspended').length;
      const body = expectProblem(
        await post('suspend', CARLA.id, version, {}, OTAVIO),
        409,
        'LAST_ADMIN_REQUIRED',
      );
      expect(body.detail).toBe('É preciso manter ao menos um administrador ativo.');
      expectProblem(
        await post('revoke', CARLA.id, version, {}, OTAVIO),
        409,
        'LAST_ADMIN_REQUIRED',
      );
      expect(eventsOf('MembershipSuspended')).toHaveLength(events);
      expect(auditOf('access.denied').at(-1)).toMatchObject({ reasonCode: 'LAST_ADMIN_REQUIRED' });
      expect(identity.membershipOf(CARLA.id, A)?.status).toBe('ACTIVE');
    });

    it('administrador suspenso não conta; com outro ADMIN_ORGAO ativo a suspensão passa', async () => {
      silence();
      // Bruno (SUSPENDED) com o ADMIN_ORGAO atribuído não mantém o tenant administrado.
      assignRole(api, { tenantId: A, membershipId: membershipIdOf(BRUNO.id), roleId: adminRoleId });
      const version = await versionOf(CARLA.id);
      expectProblem(
        await post('suspend', CARLA.id, version, {}, OTAVIO),
        409,
        'LAST_ADMIN_REQUIRED',
      );
      // Otávio passa a ter o ADMIN_ORGAO atribuído: Carla deixa de ser a última.
      assignRole(api, {
        tenantId: A,
        membershipId: membershipIdOf(OTAVIO.id),
        roleId: adminRoleId,
      });
      const response = await post('suspend', CARLA.id, version, {}, OTAVIO);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(detailOf(response).data.status).toBe('SUSPENDED');
      const reactivated = await post(
        'reactivate',
        CARLA.id,
        detailOf(response).data.version,
        {},
        OTAVIO,
      );
      expect(reactivated.status, JSON.stringify(reactivated.body)).toBe(200);
    });
  });

  describe('Revogar vínculo (USR-12)', () => {
    it('revoga de forma definitiva: evento sem o motivo, auditoria hasReason e nada mais a fazer', async () => {
      silence();
      const version = await versionOf(DIEGO.id);
      const response = await post('revoke', DIEGO.id, version, { reason: 'Exonerado em 10/10' });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const revoked = detailOf(response);
      expect(revoked.data).toMatchObject({
        status: 'REVOKED',
        revokedAt: now.toISOString(),
        revocationReason: 'Exonerado em 10/10',
      });
      expect(revoked.meta.allowedActions).toEqual([]);
      expect(eventsOf('MembershipRevoked').at(-1)).toMatchObject({
        routingKey: 'membership.revoked',
        payload: { membershipId: revoked.data.id, hasReason: true },
      });
      expect(JSON.stringify(eventsOf('MembershipRevoked').at(-1))).not.toContain('Exonerado');
      expect(auditOf('membership.revoke').at(-1)).toMatchObject({
        changes: [{ path: 'status', old: 'ACTIVE', new: 'REVOKED' }],
        metadata: { hasReason: true },
      });
      // RN-IAM-60: o vínculo REVOKED deixa de ser utilizável (ME-04 e guard de vínculo).
      const mine = await identity.listMemberships(DIEGO.id);
      expect(mine.find((membership) => membership.tenant.id === A)?.status).toBe('REVOKED');
      expectProblem(await post('revoke', DIEGO.id, revoked.data.version), 409, 'INVALID_STATE');
      expectProblem(
        await patchUser(DIEGO.id, { jobTitle: 'Volta' }, revoked.data.version),
        409,
        'INVALID_STATE',
      );
    });
  });

  describe('USR-01 — lista com filtros', () => {
    it('filtra por lotação, status e tipo; só vínculos do tenant ativo', async () => {
      const byDepartment = await as(
        request(api.server).get(`/api/v1/users?departmentId=${LICITACOES}`),
      );
      expect(byDepartment.status, JSON.stringify(byDepartment.body)).toBe(200);
      const items = (byDepartment.body as { data: TenantMembershipDto[] }).data;
      expect(items.every((item) => item.departmentIds.includes(LICITACOES))).toBe(true);

      const external = await as(
        request(api.server).get('/api/v1/users?type=EXTERNAL&status=ACTIVE'),
      );
      const externals = (external.body as { data: TenantMembershipDto[] }).data;
      expect(externals.map((item) => item.userId)).toContain(EXTERNA.id);
      expect(externals.every((item) => item.type === 'EXTERNAL')).toBe(true);

      const all = await as(request(api.server).get('/api/v1/users?pageSize=100'));
      const userIds = (all.body as { data: TenantMembershipDto[] }).data.map((item) => item.userId);
      expect(userIds).not.toContain(FABIO.id);
      expect(userIds).toContain(CARLA.id);
    });
  });
});
