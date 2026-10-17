import { describe, expect, it } from 'vitest';

import { ANTIVIRUS_CIRCUIT_POLICY, AntivirusCircuit } from './antivirus-circuit.js';

describe('AntivirusCircuit (queues.md §10.3)', () => {
  it('abre após 5 falhas seguidas, meia-abre após 30 s com UMA tentativa e fecha no sucesso', () => {
    let now = 0;
    const circuit = new AntivirusCircuit(() => new Date(now));
    for (let i = 0; i < ANTIVIRUS_CIRCUIT_POLICY.failureThreshold - 1; i += 1) {
      expect(circuit.tryAcquire()).toBe(true);
      circuit.recordFailure();
    }
    expect(circuit.state).toBe('CLOSED');
    circuit.recordFailure();
    expect(circuit.state).toBe('OPEN');
    expect(circuit.tryAcquire()).toBe(false);
    expect(circuit.retryAfterSeconds()).toBe(30);

    now += ANTIVIRUS_CIRCUIT_POLICY.openMs;
    expect(circuit.state).toBe('HALF_OPEN');
    expect(circuit.retryAfterSeconds()).toBe(0);
    expect(circuit.tryAcquire()).toBe(true);
    expect(circuit.tryAcquire()).toBe(false);
    circuit.recordFailure();
    expect(circuit.state).toBe('OPEN');

    now += ANTIVIRUS_CIRCUIT_POLICY.openMs;
    expect(circuit.tryAcquire()).toBe(true);
    circuit.recordSuccess();
    expect(circuit.state).toBe('CLOSED');
    expect(circuit.retryAfterSeconds()).toBe(0);
  });
});
