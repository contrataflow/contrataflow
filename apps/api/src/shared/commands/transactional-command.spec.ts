import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  TransactionalCommandHandler,
  failureCodeOf,
  isUnexpectedFailure,
} from './transactional-command.js';
import type { CommandTransactions } from './transactional-command.js';
import { runWithRequestContext } from '../context/request-context.js';
import { runSimulatedTransaction } from '../database/active-transaction.js';
import { DatabaseUnavailableError } from '../database/errors.js';
import type { TenantTx } from '../database/prisma.js';
import { ApiError } from '../errors/api-error.js';

class Transactions implements CommandTransactions {
  calls = 0;

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    this.calls += 1;
    return runSimulatedTransaction(work);
  }
}

/** Comando de exemplo: prepara fora, trabalha dentro, registra o commit. */
class SampleCommand extends TransactionalCommandHandler<string, number, string> {
  readonly steps: string[] = [];
  committedWith: { result: string; durationMs: number } | null = null;

  constructor(
    transactions: CommandTransactions,
    private readonly failure: Error | null = null,
  ) {
    super('sample.do', transactions);
  }

  protected prepare(input: string): Promise<number> {
    this.steps.push(`prepare:${input}`);
    return Promise.resolve(input.length);
  }

  protected handle(_tx: TenantTx, input: string, prepared: number): Promise<string> {
    this.steps.push(`handle:${input}:${String(prepared)}`);
    if (this.failure !== null) return Promise.reject(this.failure);
    return Promise.resolve(input.toUpperCase());
  }

  protected override committed(result: string, durationMs: number): void {
    this.committedWith = { result, durationMs };
  }
}

const inContext = <T>(fn: () => Promise<T>) =>
  runWithRequestContext({ correlationId: 'c-cmd', ip: '', userAgent: '' }, fn);

describe('TransactionalCommandHandler (US-001 · padrão de comando transacional)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prepara fora da transação, trabalha numa única transação e chama committed depois', async () => {
    const transactions = new Transactions();
    const command = new SampleCommand(transactions);
    await expect(inContext(() => command.execute('abc'))).resolves.toBe('ABC');
    expect(command.steps).toEqual(['prepare:abc', 'handle:abc:3']);
    expect(transactions.calls).toBe(1);
    expect(command.committedWith?.result).toBe('ABC');
    expect(command.committedWith?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('erro de regra (4xx) propaga sem log de falha; indisponibilidade registra <comando>_failed', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const rule = new SampleCommand(new Transactions(), new ApiError('VALIDATION_ERROR'));
    await expect(inContext(() => rule.execute('x'))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(error).not.toHaveBeenCalled();
    expect(rule.committedWith).toBeNull();

    const down = new SampleCommand(
      new Transactions(),
      new DatabaseUnavailableError(new Error('ECONNREFUSED')),
    );
    await expect(inContext(() => down.execute('x'))).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
    });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'sample.do_failed',
        errorCode: 'DEPENDENCY_UNAVAILABLE',
        correlationId: 'c-cmd',
      }),
      'sample.do_failed',
    );
  });

  it('classifica falhas: erro qualquer = INTERNAL_ERROR inesperado; ApiError 4xx não', () => {
    expect(failureCodeOf(new Error('boom'))).toBe('INTERNAL_ERROR');
    expect(isUnexpectedFailure(new Error('boom'))).toBe(true);
    expect(failureCodeOf(new ApiError('PERMISSION_DENIED'))).toBe('PERMISSION_DENIED');
    expect(isUnexpectedFailure(new ApiError('PERMISSION_DENIED'))).toBe(false);
    expect(isUnexpectedFailure(new ApiError('INTERNAL_ERROR'))).toBe(true);
  });
});
