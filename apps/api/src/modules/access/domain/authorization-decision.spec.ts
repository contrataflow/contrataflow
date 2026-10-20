import { describe, expect, it } from 'vitest';

import { decide, mfaPolicyNeeded, requiresMfa } from './authorization-decision.js';
import type { DecisionInput } from './authorization-decision.js';

/* US-097 — fórmula de decisão (RN-IAM-100 · permissions.md §1 · POL-14). */

const allowed: DecisionInput = {
  authenticated: true,
  tenantActive: true,
  membershipActive: true,
  riskLevel: 'LOW',
  grantedByRole: true,
  grantedByParticipation: false,
  mfaPolicy: 'ADMINS',
  hasSecondFactor: false,
};

describe('decide (RN-IAM-100)', () => {
  it('autenticado, tenant e vínculo ativos e permissão do perfil → permitido', () => {
    expect(decide(allowed)).toEqual({ allowed: true });
  });

  it('participação também concede (FA-02)', () => {
    expect(decide({ ...allowed, grantedByRole: false, grantedByParticipation: true })).toEqual({
      allowed: true,
    });
  });

  it.each([
    [{ authenticated: false }, 'UNAUTHENTICATED'],
    [{ tenantActive: false }, 'TENANT_SUSPENDED'],
    [{ membershipActive: false }, 'MEMBERSHIP_INACTIVE'],
    [{ grantedByRole: false }, 'PERMISSION_DENIED'],
    [{ riskLevel: 'HIGH' as const }, 'MFA_REQUIRED'],
  ])('%o → %s', (patch, code) => {
    expect(decide({ ...allowed, ...patch })).toEqual({ allowed: false, code });
  });

  it('a ordem segue a fórmula: sessão → tenant → vínculo → permissão → MFA', () => {
    expect(
      decide({ ...allowed, authenticated: false, tenantActive: false, grantedByRole: false }),
    ).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(decide({ ...allowed, tenantActive: false, membershipActive: false })).toMatchObject({
      code: 'TENANT_SUSPENDED',
    });
    // Sem a permissão, nunca se pede MFA (quem não pode a ação não confirma a identidade).
    expect(decide({ ...allowed, riskLevel: 'HIGH', grantedByRole: false })).toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  it('POL-14: HIGH exige MFA com ADMINS/ALL; NONE dispensa; 2º fator satisfaz', () => {
    expect(decide({ ...allowed, riskLevel: 'HIGH', mfaPolicy: 'ALL' })).toMatchObject({
      code: 'MFA_REQUIRED',
    });
    expect(decide({ ...allowed, riskLevel: 'HIGH', mfaPolicy: 'NONE' })).toEqual({ allowed: true });
    expect(decide({ ...allowed, riskLevel: 'HIGH', hasSecondFactor: true })).toEqual({
      allowed: true,
    });
    expect(decide({ ...allowed, riskLevel: 'MEDIUM', mfaPolicy: 'ALL' })).toEqual({
      allowed: true,
    });
    expect(requiresMfa('HIGH', 'ADMINS')).toBe(true);
    expect(requiresMfa('LOW', 'ALL')).toBe(false);
    expect(mfaPolicyNeeded('HIGH', false)).toBe(true);
    expect(mfaPolicyNeeded('HIGH', true)).toBe(false);
    expect(mfaPolicyNeeded('MEDIUM', false)).toBe(false);
  });
});
