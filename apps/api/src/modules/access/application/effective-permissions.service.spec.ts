import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '#config/env.js';
import { MembershipReferences } from '#shared/auth/membership-references.js';
import type { DepartmentReferenceProvider } from '#shared/auth/membership-references.js';
import {
  invalidateEffectivePermissions,
  invalidateTenantPermissions,
} from '#shared/auth/permission-cache.js';
import { InMemoryCacheStore } from '#shared/cache/cache-store.js';
import { TenantCache } from '#shared/cache/tenant-cache.js';
import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { EffectivePermissionsService } from './effective-permissions.service.js';
import type { MembershipSubject } from './effective-permissions.service.js';
import type { AccessTransactions } from './ports.js';
import type { IdentityFacade } from '../../identity/application/identity.facade.js';
import { DEFAULT_ROLES, defaultGrants, seedDefaultRoles } from '../domain/default-roles.js';
import type { RoleAssignment } from '../domain/role-assignment.js';
import type { Role } from '../domain/role.js';
import { InMemoryAccessTransactions } from '../infrastructure/access-transactions.js';
import { InMemoryRoleRepository } from '../infrastructure/in-memory-role.repository.js';
import { InMemoryRoleAssignmentRepository } from '../infrastructure/role-assignment.repository.js';

/*
 * US-097 — EffectivePermissions com cache (RN-IAM-102 · FA-01): hit/miss, tokens de geração,
 * invalidação idempotente, Redis e banco fora e a ponte por chave do modo fake.
 */

const TENANT = '0192a000-0000-7000-8000-00000000000a';
const NOW = new Date('2026-10-16T12:00:00.000Z');
const SUBJECT: MembershipSubject = {
  membershipId: '0192a000-0000-7000-8000-0000000009a1',
  userId: '0192a000-0000-7000-8000-0000000009b1',
  roleKeys: [],
};

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ correlationId: 'corr-097', ip: '', userAgent: '' }, () => {
    updateRequestContext({ tenantId: TENANT });
    return fn();
  });
}

function setup(options: { readonly transactions?: AccessTransactions } = {}) {
  const store = new InMemoryCacheStore();
  const cache = new TenantCache(store, { appEnv: 'test' } as AppConfig);
  const roles = new InMemoryRoleRepository();
  const seeded = seedDefaultRoles(TENANT, NOW, newId).map((item) => item.role);
  roles.seed(seeded, defaultGrants(seeded, DEFAULT_ROLES, NOW, newId));
  const byKey = new Map<string, Role>(seeded.map((role) => [role.key, role]));
  const assignments = new InMemoryRoleAssignmentRepository();
  const references = new MembershipReferences();
  const departments: DepartmentReferenceProvider = {
    departmentsByIds: () => Promise.resolve(new Map()),
    organizationsByIds: () => Promise.resolve(new Map()),
    subtreeIds: (_tx, ids) => Promise.resolve(new Map(ids.map((id) => [id, [id, `${id}-filha`]]))),
    departmentsHeadedBy: () => Promise.resolve(['obras']),
  };
  references.registerDepartments(departments);
  const identity = {
    departmentsOfUser: () => Promise.resolve(['obras']),
  } as unknown as IdentityFacade;
  const service = new EffectivePermissionsService(
    roles,
    assignments,
    options.transactions ?? new InMemoryAccessTransactions(),
    () => NOW,
    identity,
    references,
    cache,
  );
  const assign = (key: string, patch: Partial<RoleAssignment> = {}): RoleAssignment => {
    const role = byKey.get(key);
    if (!role) throw new Error(key);
    const record: RoleAssignment = {
      id: newId(),
      tenantId: TENANT,
      membershipId: SUBJECT.membershipId,
      roleId: role.id,
      scopeType: 'OWN_DEPARTMENTS',
      scopeOrganizationId: null,
      scopeDepartmentId: null,
      includeSubtree: true,
      validFrom: new Date('2026-01-01T00:00:00.000Z'),
      validUntil: null,
      grantedById: SUBJECT.userId,
      reason: null,
      revokedAt: null,
      revokedById: null,
      revocationReason: null,
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
      ...patch,
    };
    assignments.assignments.push(record);
    return record;
  };
  return { service, store, cache, roles, byKey, assignments, assign };
}

describe('EffectivePermissionsService (US-097)', () => {
  let log: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('cache vazio → calcula no banco e grava por 5 min; cache quente → sem banco', async () => {
    const { service, store, assignments, assign } = setup();
    assign('REQUISITANTE');
    const reads = vi.spyOn(assignments, 'listByMembership');
    const first = await inTenant(() => service.resolve(SUBJECT));
    expect(first.grants[0]).toMatchObject({
      scope: { type: 'OWN_DEPARTMENTS', departmentIds: ['obras', 'obras-filha'] },
    });
    expect(first.headOfDepartmentIds).toEqual(['obras']);
    const key = `cf:test:t:${TENANT}:access:eff:${SUBJECT.membershipId}`;
    expect(store.entries.has(key)).toBe(true);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'authorization.cache_rebuilt', cached: true }),
      'authorization.cache_rebuilt',
    );

    const second = await inTenant(() => service.resolve(SUBJECT));
    expect(second).toEqual(first);
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('troca do token do vínculo ou do tenant descarta o retrato (Concorrência)', async () => {
    const { service, cache, assignments, assign } = setup();
    assign('REQUISITANTE');
    const reads = vi.spyOn(assignments, 'listByMembership');
    await inTenant(() => service.resolve(SUBJECT));
    // Retrato regravado com tokens antigos depois da invalidação continua inválido.
    const stale = await inTenant(() => cache.getMany('access', [`eff:${SUBJECT.membershipId}`]));
    await inTenant(() => invalidateEffectivePermissions(cache, SUBJECT.membershipId));
    await inTenant(() =>
      cache.setRaw('access', `eff:${SUBJECT.membershipId}`, stale[0] ?? '', { ttlSeconds: 300 }),
    );
    await inTenant(() => service.resolve(SUBJECT));
    expect(reads).toHaveBeenCalledTimes(2);
    await inTenant(() => service.resolve(SUBJECT));
    expect(reads).toHaveBeenCalledTimes(2);
    await inTenant(() => invalidateTenantPermissions(cache));
    await inTenant(() => service.resolve(SUBJECT));
    expect(reads).toHaveBeenCalledTimes(3);
  });

  it('[Duplicidade] invalidar duas vezes é seguro: a chave some uma vez e nada é lançado', async () => {
    const { service, store, cache, assign } = setup();
    assign('REQUISITANTE');
    await inTenant(() => service.resolve(SUBJECT));
    const key = `cf:test:t:${TENANT}:access:eff:${SUBJECT.membershipId}`;
    const deleted = vi.spyOn(store, 'delete');
    await inTenant(() => invalidateEffectivePermissions(cache, SUBJECT.membershipId));
    expect(store.entries.has(key)).toBe(false);
    await expect(
      inTenant(() => invalidateEffectivePermissions(cache, SUBJECT.membershipId)),
    ).resolves.toBeUndefined();
    expect(deleted).toHaveBeenCalledWith(key);
    expect(store.entries.has(key)).toBe(false);
  });

  it('valor corrompido ou de outro vínculo no cache vira ausência', async () => {
    const { service, cache, assignments, assign } = setup();
    assign('REQUISITANTE');
    const reads = vi.spyOn(assignments, 'listByMembership');
    await inTenant(() =>
      cache.setRaw('access', `eff:${SUBJECT.membershipId}`, '{não é json', { ttlSeconds: 300 }),
    );
    await inTenant(() => service.resolve(SUBJECT));
    await inTenant(() =>
      cache.set(
        'access',
        `eff:${SUBJECT.membershipId}`,
        { v: 1, generations: { tenant: null, membership: null }, snapshot: { membershipId: 'x' } },
        { ttlSeconds: 300 },
      ),
    );
    await inTenant(() => service.resolve(SUBJECT));
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it('[Falha de integração] Redis fora → calcula sem cache e loga warn (FA-01)', async () => {
    const { service, store, assign } = setup();
    assign('REQUISITANTE');
    vi.spyOn(store, 'getMany').mockRejectedValue(new Error('ECONNREFUSED'));
    const snapshot = await inTenant(() => service.resolve(SUBJECT));
    expect(snapshot.grants).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'authorization.cache_unavailable',
        membershipId: SUBJECT.membershipId,
      }),
      'authorization.cache_unavailable',
    );
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'authorization.cache_rebuilt', cached: false }),
      'authorization.cache_rebuilt',
    );
  });

  it('Redis cai entre a leitura e a gravação → devolve o cálculo e loga warn', async () => {
    const { service, store, assign } = setup();
    assign('REQUISITANTE');
    vi.spyOn(store, 'set').mockRejectedValue(new Error('ECONNRESET'));
    const snapshot = await inTenant(() => service.resolve(SUBJECT));
    expect(snapshot.grants).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'authorization.cache_unavailable' }),
      'authorization.cache_unavailable',
    );
  });

  it('[Falha de banco] banco fora com cache vazio → 503 e error authorization.decision_failed', async () => {
    const down = (cause: Error): AccessTransactions => ({
      run: () => Promise.reject(cause),
      read: () => Promise.reject(cause),
    });
    const transient = setup({
      transactions: down(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' })),
    });
    await expect(inTenant(() => transient.service.resolve(SUBJECT))).rejects.toBeInstanceOf(
      DatabaseUnavailableError,
    );
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'authorization.decision_failed',
        errorCode: 'DEPENDENCY_UNAVAILABLE',
        correlationId: 'corr-097',
      }),
      'authorization.decision_failed',
    );
    const already = setup({ transactions: down(new DatabaseUnavailableError(new Error('x'))) });
    await expect(inTenant(() => already.service.resolve(SUBJECT))).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
    });
    const bug = setup({ transactions: down(new TypeError('bug')) });
    await expect(inTenant(() => bug.service.resolve(SUBJECT))).rejects.toBeInstanceOf(TypeError);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'INTERNAL_ERROR' }),
      'authorization.decision_failed',
    );
  });

  describe('ponte por chave (vínculo sem nenhuma atribuição gravada)', () => {
    it('usa o escopo padrão do perfil: TENANT ou lotações (ORGANIZATION nunca amplia)', async () => {
      const { service } = setup();
      const snapshot = await inTenant(() =>
        service.resolve({ ...SUBJECT, roleKeys: ['GESTOR_CONTRATACOES', 'AUTORIDADE_COMPETENTE'] }),
      );
      expect(snapshot.grants.map((grant) => grant.scope)).toEqual([
        {
          type: 'OWN_DEPARTMENTS',
          organizationId: null,
          departmentId: null,
          includeSubtree: false,
          departmentIds: ['obras'],
        },
        {
          type: 'TENANT',
          organizationId: null,
          departmentId: null,
          includeSubtree: false,
          departmentIds: [],
        },
      ]);
    });

    it('perfil inativo no tenant não concede; chave sem perfil cai na matriz padrão', async () => {
      const { service, roles, byKey } = setup();
      const auditor = byKey.get('AUDITOR');
      if (!auditor) throw new Error('AUDITOR');
      await inTenant(() =>
        roles.update({} as TenantTx, { ...auditor, isActive: false }, auditor.version),
      );
      const inactive = await inTenant(() => service.resolve({ ...SUBJECT, roleKeys: ['AUDITOR'] }));
      expect(inactive.grants).toEqual([]);
      const unknown = await inTenant(() =>
        service.resolve({ ...SUBJECT, membershipId: newId(), roleKeys: ['NAO_EXISTE'] }),
      );
      expect(unknown.grants).toEqual([]);
    });

    it('vínculo que já teve atribuição (mesmo revogada) não volta à ponte', async () => {
      const { service, assign } = setup();
      assign('REQUISITANTE', { revokedAt: new Date('2026-10-01T00:00:00.000Z') });
      const snapshot = await inTenant(() =>
        service.resolve({ ...SUBJECT, roleKeys: ['ADMIN_ORGAO'] }),
      );
      expect(snapshot.grants).toEqual([]);
    });
  });

  it('atribuição de perfil removido do tenant não concede nada', async () => {
    const { service, assign } = setup();
    assign('REQUISITANTE', { roleId: newId() });
    const snapshot = await inTenant(() => service.resolve(SUBJECT));
    expect(snapshot.grants).toEqual([]);
  });
});
