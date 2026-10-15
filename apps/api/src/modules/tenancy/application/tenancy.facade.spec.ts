import { describe, expect, it, vi } from 'vitest';

import { TenancyFacade } from './tenancy.facade.js';

describe('TenancyFacade', () => {
  it('invalida o status do tenant em cache (US-100)', async () => {
    const invalidate = vi.fn(() => Promise.resolve());
    await new TenancyFacade({ invalidate }).invalidateTenantStatus('t-1');
    expect(invalidate).toHaveBeenCalledWith('t-1');
  });
});
