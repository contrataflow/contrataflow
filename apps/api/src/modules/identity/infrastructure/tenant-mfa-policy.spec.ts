import { describe, expect, it } from 'vitest';

import { InMemoryTenantMfaPolicy, RegistryDefaultMfaPolicy } from './tenant-mfa-policy.js';

/* `security.mfaPolicy` por instituição (US-093): padrão do registro até a US-103. */

const TENANT = '0192a000-0000-7000-8000-00000000000b';

describe('política de MFA por instituição', () => {
  it('sem configurações do tenant, vale o padrão do registro (ADMINS)', async () => {
    await expect(new RegistryDefaultMfaPolicy().mfaPolicyOf()).resolves.toBe('ADMINS');
  });

  it('em memória: por instituição, com o padrão para as demais', async () => {
    const policies = new InMemoryTenantMfaPolicy({ [TENANT]: 'ALL' });
    await expect(policies.mfaPolicyOf(TENANT)).resolves.toBe('ALL');
    await expect(policies.mfaPolicyOf('outra')).resolves.toBe('ADMINS');
    policies.set(TENANT, 'NONE');
    await expect(policies.mfaPolicyOf(TENANT)).resolves.toBe('NONE');
  });
});
