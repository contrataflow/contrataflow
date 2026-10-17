import { describe, expect, it } from 'vitest';

import { setBudgetConfidential } from './process-confidentiality.js';
import type { Process } from './process.js';

const NOW = new Date('2026-10-05T15:00:00.000Z');
const USER = '0192a000-0000-7000-8000-0000000000a6';

const process = {
  id: '0192d013-0000-7000-8000-000000000012',
  estimatedValue: '150000.00',
  isBudgetConfidential: false,
  updatedAt: new Date('2026-10-01T12:00:00.000Z'),
  updatedById: null,
  version: 1,
} as unknown as Process;

describe('setBudgetConfidential (US-013 · RN-PROC-137)', () => {
  it('ativa o sigilo com version + 1, quem alterou e quando — o valor estimado não muda', () => {
    expect(setBudgetConfidential(process, true, { now: NOW, userId: USER })).toMatchObject({
      isBudgetConfidential: true,
      estimatedValue: '150000.00',
      updatedAt: NOW,
      updatedById: USER,
      version: 2,
    });
  });

  it('desativa o sigilo de um processo sigiloso', () => {
    const confidential = { ...process, isBudgetConfidential: true, version: 2 };
    expect(setBudgetConfidential(confidential, false, { now: NOW, userId: USER })).toMatchObject({
      isBudgetConfidential: false,
      version: 3,
    });
  });

  it('flag já no estado pedido: null (nada a gravar)', () => {
    expect(setBudgetConfidential(process, false, { now: NOW, userId: USER })).toBeNull();
  });
});
