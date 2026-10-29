import type { PermissionCode } from '@contrataflow/types';
import { describe, expect, it } from 'vitest';

import type { AppConfig } from '#config/env.js';
import type { EffectivePermissionsSnapshot } from '#shared/auth/effective-permissions.js';
import { MembershipReferences } from '#shared/auth/membership-references.js';
import { InMemoryCacheStore } from '#shared/cache/cache-store.js';
import { TenantCache } from '#shared/cache/tenant-cache.js';
import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { EffectivePermissionsService } from './effective-permissions.service.js';
import { authorizeActor, RoleActorResolver } from './role-actor.js';
import type { IdentityFacade } from '../../identity/application/identity.facade.js';
import { DEFAULT_ROLES, defaultGrants, seedDefaultRoles } from '../domain/default-roles.js';
import type { RoleAssignment } from '../domain/role-assignment.js';
import type { Role } from '../domain/role.js';
import { InMemoryAccessTransactions } from '../infrastructure/access-transactions.js';
import { InMemoryRoleRepository } from '../infrastructure/in-memory-role.repository.js';
import { InMemoryRoleAssignmentRepository } from '../infrastructure/role-assignment.repository.js';

/*
 * spec-530 — o ator da gestão de perfis (ROL-02..08 · POL-13) decide pelas permissões efetivas da
 * requisição (US-097), não pelas chaves do vínculo: o vínculo lido do PostgreSQL chega sem
 * `roleKeys`, e a administradora atribuída pela ROL-11 era recusada em ROL-02.
 */

const TENANT = '0192a000-0000-7000-8000-00000000530a';
const MEMBERSHIP = '0192a000-0000-7000-8000-0000000530a1';
const USER = '0192a000-0000-7000-8000-0000000530b1';
const NOW = new Date('2026-10-29T12:00:00.000Z');
const TX = {} as TenantTx;

function setup() {
  const roles = new InMemoryRoleRepository();
  const seeded = seedDefaultRoles(TENANT, NOW, newId).map((item) => item.role);
  roles.seed(seeded, defaultGrants(seeded, DEFAULT_ROLES, NOW, newId));
  const byKey = new Map<string, Role>(seeded.map((role) => [role.key, role]));
  const assignments = new InMemoryRoleAssignmentRepository();
  const references = new MembershipReferences();
  references.registerDepartments({
    departmentsByIds: () => Promise.resolve(new Map()),
    organizationsByIds: () => Promise.resolve(new Map()),
    subtreeIds: (_tx, ids) => Promise.resolve(new Map(ids.map((id) => [id, [id]]))),
    departmentsHeadedBy: () => Promise.resolve([]),
  });
  const identity = { departmentsOfUser: () => Promise.resolve([]) } as unknown as IdentityFacade;
  const effective = new EffectivePermissionsService(
    roles,
    assignments,
    new InMemoryAccessTransactions(),
    () => NOW,
    identity,
    references,
    new TenantCache(new InMemoryCacheStore(), { appEnv: 'test' } as AppConfig),
  );
  const resolver = new RoleActorResolver(effective);
  const role = (key: string): Role => {
    const found = byKey.get(key);
    if (!found) throw new Error(key);
    return found;
  };
  const assign = (key: string, patch: Partial<RoleAssignment> = {}): void => {
    assignments.assignments.push({
      id: newId(),
      tenantId: TENANT,
      membershipId: MEMBERSHIP,
      roleId: role(key).id,
      scopeType: 'TENANT',
      scopeOrganizationId: null,
      scopeDepartmentId: null,
      includeSubtree: false,
      validFrom: new Date('2026-01-01T00:00:00.000Z'),
      validUntil: null,
      grantedById: USER,
      reason: null,
      revokedAt: null,
      revokedById: null,
      revocationReason: null,
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
      ...patch,
    });
  };
  return { resolver, effective, roles, role, assign };
}

/** Requisição do vínculo; `roleKeys` vazio = o vínculo como o repositório Prisma o devolve. */
function asMember<T>(
  fn: () => Promise<T>,
  options: {
    readonly roleKeys?: readonly string[];
    readonly permissions?: EffectivePermissionsSnapshot;
    readonly membershipId?: string | null;
  } = {},
): Promise<T> {
  return runWithRequestContext({ correlationId: 'corr-530', ip: '', userAgent: '' }, () => {
    updateRequestContext({
      tenantId: TENANT,
      actor: {
        type: 'USER',
        userId: USER,
        membershipId: options.membershipId === undefined ? MEMBERSHIP : options.membershipId,
      },
      roleKeys: options.roleKeys ?? [],
      ...(options.permissions ? { permissions: options.permissions } : {}),
    });
    return fn();
  });
}

const snapshotWith = (permissions: readonly PermissionCode[]): EffectivePermissionsSnapshot => ({
  membershipId: MEMBERSHIP,
  userId: USER,
  grants: [
    {
      scope: {
        type: 'TENANT',
        organizationId: null,
        departmentId: null,
        includeSubtree: false,
        departmentIds: [],
      },
      permissions: [...permissions],
    },
  ],
  ownDepartmentIds: [],
  headOfDepartmentIds: [],
  computedAt: NOW.toISOString(),
});

describe('RoleActorResolver — permissões efetivas da requisição (spec-530)', () => {
  it('ADMIN_ORGAO atribuído (ROL-11) e vínculo sem roleKeys: ROLE_VIEW/ROLE_MANAGE e isento do POL-13', async () => {
    const { resolver, assign } = setup();
    assign('ADMIN_ORGAO');
    const actor = await asMember(() => resolver.resolve(TX));
    expect(actor.isTenantAdmin).toBe(true);
    expect(actor.permissions.has('ROLE_VIEW')).toBe(true);
    expect(actor.permissions.has('ROLE_MANAGE')).toBe(true);
    expect(() => {
      authorizeActor(actor, 'ROLE_MANAGE', 'NONE');
    }).not.toThrow();
  });

  it('usa o retrato do AuthorizationGuard no contexto (o mesmo de ROL-01 e ME-03)', async () => {
    const { resolver, assign } = setup();
    assign('ADMIN_ORGAO');
    const actor = await asMember(() => resolver.resolve(TX), {
      permissions: snapshotWith(['ROLE_VIEW']),
    });
    expect([...actor.permissions]).toEqual(['ROLE_VIEW']);
    expect(actor.isTenantAdmin).toBe(true);
  });

  it('une as permissões de todas as atribuições vigentes, em qualquer escopo', async () => {
    const { resolver, assign } = setup();
    assign('REQUISITANTE', { scopeType: 'OWN_DEPARTMENTS' });
    assign('AUDITOR');
    const actor = await asMember(() => resolver.resolve(TX));
    expect(actor.isTenantAdmin).toBe(false);
    expect(actor.permissions.has('PROCESS_CREATE')).toBe(true);
    expect(actor.permissions.has('AUDIT_VIEW')).toBe(true);
    expect(actor.permissions.has('ROLE_MANAGE')).toBe(false);
  });

  it('sem ROLE_VIEW → authorizeActor recusa com PERMISSION_DENIED e a permissão no reasonCode', async () => {
    const { resolver, assign } = setup();
    assign('REQUISITANTE');
    const actor = await asMember(() => resolver.resolve(TX));
    expect(actor.permissions.has('ROLE_VIEW')).toBe(false);
    let denial: unknown;
    try {
      authorizeActor(actor, 'ROLE_VIEW', 'NONE');
    } catch (error) {
      denial = error;
    }
    expect(denial).toBeInstanceOf(ApiError);
    expect(denial).toMatchObject({ code: 'PERMISSION_DENIED', auditReasonCode: 'ROLE_VIEW' });
  });

  it('com atribuição gravada, as chaves do vínculo não concedem nada', async () => {
    const { resolver, assign } = setup();
    assign('REQUISITANTE');
    const actor = await asMember(() => resolver.resolve(TX), { roleKeys: ['ADMIN_ORGAO'] });
    expect(actor.isTenantAdmin).toBe(false);
    expect(actor.permissions.has('ROLE_MANAGE')).toBe(false);
  });

  it.each([
    ['revogada', { revokedAt: new Date('2026-10-01T00:00:00.000Z') }],
    ['vencida', { validUntil: new Date('2026-10-01T00:00:00.000Z') }],
    ['futura', { validFrom: new Date('2026-11-01T00:00:00.000Z') }],
    [
      'com escopo de unidade',
      { scopeType: 'DEPARTMENT', scopeDepartmentId: '0192a000-0000-7000-8000-0000000530d1' },
    ],
  ] as const)('ADMIN_ORGAO %s não isenta do POL-13', async (_label, patch) => {
    const { resolver, assign } = setup();
    assign('ADMIN_ORGAO', patch);
    const actor = await asMember(() => resolver.resolve(TX));
    expect(actor.isTenantAdmin).toBe(false);
  });

  it('perfil ADMIN_ORGAO inativo: nem permissões nem isenção', async () => {
    const { resolver, roles, role, assign } = setup();
    assign('ADMIN_ORGAO');
    const admin = role('ADMIN_ORGAO');
    const actor = await asMember(async () => {
      await roles.update(TX, { ...admin, isActive: false }, admin.version);
      return resolver.resolve(TX);
    });
    expect(actor.isTenantAdmin).toBe(false);
    expect(actor.permissions.size).toBe(0);
  });

  it('ponte: sem nenhuma atribuição gravada, valem as chaves do vínculo (modo fake)', async () => {
    const { resolver } = setup();
    const admin = await asMember(() => resolver.resolve(TX), { roleKeys: ['ADMIN_ORGAO'] });
    expect(admin.isTenantAdmin).toBe(true);
    expect(admin.permissions.has('ROLE_MANAGE')).toBe(true);
    const requester = await asMember(() => resolver.resolve(TX), { roleKeys: ['REQUISITANTE'] });
    expect(requester.isTenantAdmin).toBe(false);
    expect(requester.permissions.has('ROLE_VIEW')).toBe(false);
  });

  it('sem vínculo (job, ator de plataforma): nenhuma permissão', async () => {
    const { resolver } = setup();
    const actor = await asMember(() => resolver.resolve(TX), {
      membershipId: null,
      roleKeys: ['ADMIN_ORGAO'],
    });
    expect(actor).toEqual({ permissions: new Set(), isTenantAdmin: false });
  });
});
