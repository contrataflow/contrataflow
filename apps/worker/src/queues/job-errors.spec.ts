import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CIRCUIT_STATE_VALUE, CircuitBreaker } from './circuit-breaker.js';
import {
  DependencyUnavailableError,
  ExpectedDuplicateError,
  JobTimeoutError,
  PermanentJobError,
  SecurityJobError,
  classifyJobError,
  isConnectionError,
} from './job-errors.js';

const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

describe('classificação de erros de job (RN-FND-66 · queues.md §10.2)', () => {
  it('permanentes, de segurança e de contrato', () => {
    expect(classifyJobError(new PermanentJobError('INVALID_JOB_PAYLOAD'))).toBe('PERMANENT');
    expect(classifyJobError(new UnrecoverableError('x'))).toBe('PERMANENT');
    expect(classifyJobError(z.string().safeParse(1).error)).toBe('PERMANENT');
    expect(classifyJobError(new SecurityJobError('TENANT_CONTEXT_REQUIRED'))).toBe('SECURITY');
    expect(classifyJobError(pgError('42501'))).toBe('SECURITY');
  });

  it('duplicidade esperada (23505 de idempotência) e dependência fora', () => {
    expect(classifyJobError(new ExpectedDuplicateError())).toBe('DUPLICATE');
    expect(classifyJobError(pgError('23505'))).toBe('DUPLICATE');
    expect(classifyJobError(new DependencyUnavailableError('gotenberg'))).toBe('DEPENDENCY_DOWN');
  });

  it('transitórios: timeout, conexão, serialização/deadlock e o desconhecido', () => {
    expect(classifyJobError(new JobTimeoutError(10))).toBe('TRANSIENT');
    for (const code of ['40001', '40P01', '55P03', '57P01', '08006']) {
      expect(classifyJobError(pgError(code))).toBe('TRANSIENT');
    }
    expect(classifyJobError(new TypeError('x is undefined'))).toBe('TRANSIENT');
    expect(classifyJobError('string solta')).toBe('TRANSIENT');
  });

  it('isConnectionError reconhece rede, SQLSTATE 08 e as mensagens do driver', () => {
    expect(isConnectionError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(isConnectionError(pgError('08001'))).toBe(true);
    expect(isConnectionError(pgError('57P03'))).toBe(true);
    expect(isConnectionError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isConnectionError(pgError('23505'))).toBe(false);
    expect(isConnectionError(null)).toBe(false);
  });
});

describe('circuit breaker (queues.md §10.3)', () => {
  const refused = () => Promise.reject(Object.assign(new Error('down'), { code: 'ECONNREFUSED' }));

  it('abre após N falhas de conexão, recusa sem chamar e fecha após a meia-abertura', async () => {
    let now = 0;
    const breaker = new CircuitBreaker({
      dependency: 'gotenberg',
      failureThreshold: 2,
      openMs: 30_000,
      now: () => now,
    });
    await expect(breaker.execute(refused)).rejects.toThrow('down');
    expect(breaker.state).toBe('CLOSED');
    await expect(breaker.execute(refused)).rejects.toThrow('down');
    expect(breaker.state).toBe('OPEN');
    let calls = 0;
    await expect(
      breaker.execute(() => {
        calls += 1;
        return Promise.resolve('ok');
      }),
    ).rejects.toBeInstanceOf(DependencyUnavailableError);
    expect(calls).toBe(0);

    now = 30_000;
    expect(breaker.state).toBe('HALF_OPEN');
    await expect(breaker.execute(() => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(breaker.state).toBe('CLOSED');
    expect(CIRCUIT_STATE_VALUE[breaker.state]).toBe(0);
  });

  it('falha na meia-abertura reabre; erro de regra não conta; trip/reset manuais', async () => {
    let now = 0;
    const breaker = new CircuitBreaker({
      dependency: 'clamav',
      failureThreshold: 5,
      now: () => now,
    });
    await expect(breaker.execute(() => Promise.reject(new Error('regra')))).rejects.toThrow(
      'regra',
    );
    expect(breaker.state).toBe('CLOSED');
    breaker.trip();
    expect(breaker.state).toBe('OPEN');
    now = 30_000;
    await expect(breaker.execute(refused)).rejects.toThrow('down');
    expect(breaker.state).toBe('OPEN');
    breaker.reset();
    expect(breaker.state).toBe('CLOSED');
  });

  it('na meia-abertura só uma tentativa passa por vez', async () => {
    let now = 0;
    const breaker = new CircuitBreaker({ dependency: 'smtp', now: () => now });
    breaker.trip();
    now = 30_000;
    let release: (value: string) => void = () => undefined;
    const trial = breaker.execute(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    await expect(breaker.execute(() => Promise.resolve('x'))).rejects.toBeInstanceOf(
      DependencyUnavailableError,
    );
    release('ok');
    await expect(trial).resolves.toBe('ok');
  });
});
