import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MFA_POLICY,
  MFA_POLICIES,
  hasSecondFactor,
  tenantEntryRequiresMfa,
} from './mfa-policy.js';

/* Política de MFA por instituição (DEC-133 · POL-14 · RN-IAM-39/69): funções puras. */

describe('hasSecondFactor (RFC 8176)', () => {
  it.each([['otp'], ['mfa'], ['hwk'], ['swk'], ['fpt'], ['face']])(
    '%s comprova segundo fator',
    (amr) => {
      expect(hasSecondFactor(['pwd', amr])).toBe(true);
    },
  );

  it('só senha (ou nada) não comprova', () => {
    expect(hasSecondFactor(['pwd'])).toBe(false);
    expect(hasSecondFactor([])).toBe(false);
  });
});

describe('tenantEntryRequiresMfa (RN-IAM-69)', () => {
  it('padrão do registro é ADMINS', () => {
    expect(DEFAULT_MFA_POLICY).toBe('ADMINS');
    expect(MFA_POLICIES).toEqual(['NONE', 'ADMINS', 'ALL']);
  });

  it('ALL sem segundo fator suspende a entrada; com MFA, libera', () => {
    expect(tenantEntryRequiresMfa('ALL', ['pwd'])).toBe(true);
    expect(tenantEntryRequiresMfa('ALL', ['pwd', 'otp'])).toBe(false);
  });

  it('ADMINS cobra o MFA na ação de risco alto, não na entrada; NONE nunca', () => {
    expect(tenantEntryRequiresMfa('ADMINS', ['pwd'])).toBe(false);
    expect(tenantEntryRequiresMfa('NONE', [])).toBe(false);
  });
});
