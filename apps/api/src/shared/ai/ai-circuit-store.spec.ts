import { describe, expect, it } from 'vitest';

import {
  AI_CIRCUIT_POLICY,
  CLOSED_CIRCUIT,
  circuitRetryAfterSeconds,
  isCircuitOpen,
  recordCircuitFailure,
} from './ai-circuit-store.js';
import type { AiCircuitSnapshot } from './ai-circuit-store.js';

const T0 = 1_760_000_000_000;

function failures(count: number, spacingMs = 1_000, start = CLOSED_CIRCUIT): AiCircuitSnapshot {
  let state = start;
  for (let index = 0; index < count; index += 1) {
    state = recordCircuitFailure(state, T0 + index * spacingMs);
  }
  return state;
}

describe('disjuntor do provedor de IA (RN-AI-08)', () => {
  it('5 falhas consecutivas em 60 s abrem o circuito por 60 s', () => {
    expect(isCircuitOpen(failures(4), T0 + 4_000)).toBe(false);
    const open = failures(5);
    const last = T0 + 4_000;
    expect(open.openUntil).toBe(last + AI_CIRCUIT_POLICY.openMs);
    expect(isCircuitOpen(open, last + 59_999)).toBe(true);
    expect(isCircuitOpen(open, last + 60_000)).toBe(false);
    expect(circuitRetryAfterSeconds(open, last + 30_500)).toBe(30);
  });

  it('falhas espaçadas além da janela recomeçam a contagem', () => {
    // 0, 20, 40 e 60 s cabem na janela da 1ª falha; a de 80 s recomeça a sequência.
    const spaced = failures(5, 20_000);
    expect(spaced.openUntil).toBeNull();
    expect(spaced.consecutiveFailures).toBe(1);
    expect(spaced.firstFailureAt).toBe(T0 + 80_000);
  });

  it('fechado: Retry-After mínimo de 1 s; a contagem zera ao abrir', () => {
    expect(circuitRetryAfterSeconds(CLOSED_CIRCUIT, T0)).toBe(1);
    expect(failures(5).consecutiveFailures).toBe(0);
  });
});
