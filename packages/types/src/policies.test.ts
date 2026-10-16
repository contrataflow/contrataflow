import { describe, expect, it } from 'vitest';

import { CONTEXTUAL_POLICIES, isPolicyId, POLICY_IDS } from './index.js';

describe('políticas contextuais (permissions.md §6)', () => {
  it('cataloga POL-01..17 em sequência, sem repetição', () => {
    expect(POLICY_IDS).toEqual(
      Array.from({ length: 17 }, (_, index) => `POL-${String(index + 1).padStart(2, '0')}`),
    );
  });

  it('cada política tem código de recusa em SCREAMING_SNAKE_CASE', () => {
    for (const policy of CONTEXTUAL_POLICIES) {
      expect(policy.denialCode).toMatch(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/);
      expect(policy.name.length).toBeGreaterThan(2);
    }
  });

  it('reconhece só os IDs do catálogo', () => {
    expect(isPolicyId('POL-13')).toBe(true);
    expect(isPolicyId('POL-18')).toBe(false);
  });
});
