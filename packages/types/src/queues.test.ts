import { describe, expect, it } from 'vitest';

import {
  PLATFORM_JOBS,
  QUEUE_JOBS,
  QUEUE_NAMES,
  isPlatformJob,
  isRegisteredJob,
} from './queues.js';

describe('registro de filas e jobs (queues.md §4 · §9.3 · V-03)', () => {
  it('tem as nove filas do MVP 1, cada uma com ao menos um job registrado', () => {
    expect(QUEUE_NAMES).toHaveLength(9);
    for (const queue of QUEUE_NAMES) expect(QUEUE_JOBS[queue].length).toBeGreaterThan(0);
  });

  it('todo job de plataforma é um job registrado na mesma fila', () => {
    for (const [queue, jobs] of Object.entries(PLATFORM_JOBS)) {
      for (const job of jobs) expect(isRegisteredJob(queue, job)).toBe(true);
    }
  });

  it('isRegisteredJob recusa fila ou job fora do registro', () => {
    expect(isRegisteredJob('email', 'send')).toBe(true);
    expect(isRegisteredJob('email', 'scan')).toBe(false);
    expect(isRegisteredJob('webhooks', 'send')).toBe(false);
    expect(isRegisteredJob('toString', 'send')).toBe(false);
  });

  it('isPlatformJob só aceita a lista fechada', () => {
    expect(isPlatformJob('deadlines', 'tick')).toBe(true);
    expect(isPlatformJob('deadlines', 'scan-tenant')).toBe(false);
    expect(isPlatformJob('notifications', 'event')).toBe(false);
    expect(isPlatformJob('dead-letter', 'dead-letter')).toBe(true);
    expect(isPlatformJob('constructor', 'tick')).toBe(false);
  });
});
