import { describe, expect, it } from 'vitest';

import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { IdentityFacade } from './identity.facade.js';
import { InMemoryIdentityRepository } from '../infrastructure/in-memory-identity.repositories.js';
import { InMemoryTenantMfaPolicy } from '../infrastructure/tenant-mfa-policy.js';

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;

function inTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ correlationId: 'c', ip: '', userAgent: '' }, () => {
    updateRequestContext({ tenantId });
    return fn();
  });
}

describe('IdentityFacade', () => {
  const facade = new IdentityFacade(
    new InMemoryIdentityRepository(),
    new InMemoryTenantMfaPolicy(),
  );
  const tx = {} as TenantTx;
  const memberOfA = FAKE_MEMBERSHIPS.filter((m) => m.tenantId === A).map((m) => m.userId);
  const [first] = memberOfA;
  const outsider = Object.values(FAKE_USERS).find(
    (user) => !FAKE_MEMBERSHIPS.some((m) => m.userId === user.id && m.tenantId === B),
  );

  it('userDisplayNames: nome exibido de quem tem vínculo no tenant da transação', async () => {
    const names = await inTenant(A, () => facade.userDisplayNames(tx, memberOfA));
    expect(names.size).toBe(new Set(memberOfA).size);
    const user = Object.values(FAKE_USERS).find((candidate) => candidate.id === first);
    expect(names.get(first ?? '')).toBe(user?.socialName ?? user?.name);
  });

  it('userDisplayNames: usuário sem vínculo no tenant não é encontrado', async () => {
    const names = await inTenant(B, () => facade.userDisplayNames(tx, [outsider?.id ?? '']));
    expect(names.size).toBe(0);
  });

  it('membersInTenant: vínculo, situação e perfis só de quem tem vínculo no tenant', async () => {
    const members = await inTenant(A, () =>
      facade.membersInTenant(tx, [FAKE_USERS.ana.id, FAKE_USERS.bruno.id, FAKE_USERS.paulo.id]),
    );
    expect(members.map((m) => [m.userId, m.status]).sort()).toEqual(
      [
        [FAKE_USERS.ana.id, 'ACTIVE'],
        [FAKE_USERS.bruno.id, 'SUSPENDED'],
      ].sort(),
    );
    expect(members.find((m) => m.userId === FAKE_USERS.ana.id)?.roleKeys).toEqual(['REQUISITANTE']);
  });

  it('lotações na unidade (US-102): quem está lotado, só no tenant da transação', async () => {
    const repository = new InMemoryIdentityRepository();
    const custom = new IdentityFacade(repository, new InMemoryTenantMfaPolicy());
    const unit = '0192a000-0000-7000-8000-0000000200a1';
    const ana = FAKE_MEMBERSHIPS.find((m) => m.userId === FAKE_USERS.ana.id && m.tenantId === A);
    await expect(inTenant(A, () => custom.hasDepartmentAssignments(tx, unit))).resolves.toBe(false);
    repository.assignDepartment(ana?.id ?? '', unit);
    const ids = [FAKE_USERS.ana.id, FAKE_USERS.marta.id];
    await expect(
      inTenant(A, () => custom.usersAssignedToDepartment(tx, unit, ids)),
    ).resolves.toEqual(new Set([FAKE_USERS.ana.id]));
    await expect(
      inTenant(A, () => custom.usersAssignedToDepartment(tx, unit, [])),
    ).resolves.toEqual(new Set());
    await expect(inTenant(A, () => custom.hasDepartmentAssignments(tx, unit))).resolves.toBe(true);
    await expect(inTenant(B, () => custom.hasDepartmentAssignments(tx, unit))).resolves.toBe(false);
    await expect(
      inTenant(B, () => custom.usersAssignedToDepartment(tx, unit, ids)),
    ).resolves.toEqual(new Set());
  });

  it('mfaPolicy: política do tenant da requisição (padrão ADMINS)', async () => {
    const policies = new InMemoryTenantMfaPolicy({ [B]: 'ALL' });
    const custom = new IdentityFacade(new InMemoryIdentityRepository(), policies);
    await expect(inTenant(A, () => custom.mfaPolicy())).resolves.toBe('ADMINS');
    await expect(inTenant(B, () => custom.mfaPolicy())).resolves.toBe('ALL');
  });

  it('departmentsOfUser (US-041): lotações do vínculo ativo, só no tenant da transação', async () => {
    const repository = new InMemoryIdentityRepository();
    const custom = new IdentityFacade(repository, new InMemoryTenantMfaPolicy());
    const unit = '0192a000-0000-7000-8000-0000000200b1';
    const ana = FAKE_MEMBERSHIPS.find((m) => m.userId === FAKE_USERS.ana.id && m.tenantId === A);
    const bruno = FAKE_MEMBERSHIPS.find((m) => m.userId === FAKE_USERS.bruno.id);
    repository.assignDepartment(ana?.id ?? '', unit);
    repository.assignDepartment(ana?.id ?? '', unit);
    repository.assignDepartment(bruno?.id ?? '', unit);
    await expect(
      inTenant(A, () => custom.departmentsOfUser(tx, FAKE_USERS.ana.id)),
    ).resolves.toEqual([unit]);
    // Vínculo suspenso não conta; outro tenant não vê.
    await expect(
      inTenant(A, () => custom.departmentsOfUser(tx, FAKE_USERS.bruno.id)),
    ).resolves.toEqual([]);
    await expect(
      inTenant(B, () => custom.departmentsOfUser(tx, FAKE_USERS.ana.id)),
    ).resolves.toEqual([]);
  });
});
