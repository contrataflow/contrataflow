import { describe, expect, it } from 'vitest';

import { canReadOffboardingTenant, membershipAccess } from './membership-policy.js';
import type { MembershipAccessInput } from './membership-policy.js';
import type { TenantStatus } from './ports.js';

/* RN-IAM-08 · DEC-132: vínculo utilizável por status do vínculo, validade e status da instituição. */

const NOW = new Date('2026-10-14T12:00:00Z');

function input(overrides: Partial<MembershipAccessInput> = {}): MembershipAccessInput {
  return { status: 'ACTIVE', expiresAt: null, tenantStatus: 'ACTIVE', roleKeys: [], ...overrides };
}

describe('membershipAccess (RN-IAM-08)', () => {
  it('vínculo ACTIVE sem prazo em instituição ACTIVE: utilizável, escrita liberada', () => {
    expect(membershipAccess(input(), NOW)).toEqual({ usable: true, readOnly: false });
  });

  it.each(['INVITED', 'SUSPENDED', 'REVOKED', 'EXPIRED'] as const)(
    'vínculo %s não é utilizável (MEMBERSHIP_INACTIVE)',
    (status) => {
      expect(membershipAccess(input({ status }), NOW)).toEqual({
        usable: false,
        reason: 'MEMBERSHIP_INACTIVE',
      });
    },
  );

  it('expiresAt vencido (ou exatamente agora) torna o vínculo inativo; futuro mantém', () => {
    expect(membershipAccess(input({ expiresAt: NOW }), NOW)).toMatchObject({ usable: false });
    expect(
      membershipAccess(input({ expiresAt: new Date('2026-10-14T11:59:59Z') }), NOW),
    ).toMatchObject({ usable: false, reason: 'MEMBERSHIP_INACTIVE' });
    expect(
      membershipAccess(input({ expiresAt: new Date('2026-10-15T00:00:00Z') }), NOW),
    ).toMatchObject({ usable: true });
  });

  it.each<TenantStatus | null>(['PROVISIONING', 'SUSPENDED', 'DEACTIVATED', null])(
    'instituição %s nunca é utilizável por usuários (TENANT_SUSPENDED)',
    (tenantStatus) => {
      expect(membershipAccess(input({ tenantStatus, roleKeys: ['ADMIN_ORGAO'] }), NOW)).toEqual({
        usable: false,
        reason: 'TENANT_SUSPENDED',
      });
    },
  );

  it('OFFBOARDING: ADMIN_ORGAO e AUDITOR em somente leitura; demais perfis recusados', () => {
    const offboarding = (roleKeys: string[]) =>
      membershipAccess(input({ tenantStatus: 'OFFBOARDING', roleKeys }), NOW);
    expect(offboarding(['AUDITOR'])).toEqual({ usable: true, readOnly: true });
    expect(offboarding(['REQUISITANTE', 'ADMIN_ORGAO'])).toEqual({ usable: true, readOnly: true });
    expect(offboarding(['REQUISITANTE'])).toEqual({ usable: false, reason: 'TENANT_SUSPENDED' });
    expect(offboarding([])).toEqual({ usable: false, reason: 'TENANT_SUSPENDED' });
  });

  it('o status do vínculo prevalece sobre o da instituição', () => {
    expect(
      membershipAccess(input({ status: 'SUSPENDED', tenantStatus: 'SUSPENDED' }), NOW),
    ).toEqual({ usable: false, reason: 'MEMBERSHIP_INACTIVE' });
  });

  it('canReadOffboardingTenant reconhece só os perfis da lista fechada', () => {
    expect(canReadOffboardingTenant(['AUDITOR'])).toBe(true);
    expect(canReadOffboardingTenant(['auditor', 'GESTOR_CONTRATACOES'])).toBe(false);
  });
});
