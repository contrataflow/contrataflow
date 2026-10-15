import { describe, expect, it } from 'vitest';

import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { IdentityFacade } from './identity.facade.js';
import { InMemoryIdentityRepository } from '../infrastructure/in-memory-identity.repositories.js';

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;

function inTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ correlationId: 'c', ip: '', userAgent: '' }, () => {
    updateRequestContext({ tenantId });
    return fn();
  });
}

describe('IdentityFacade', () => {
  const facade = new IdentityFacade(new InMemoryIdentityRepository());
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
});
