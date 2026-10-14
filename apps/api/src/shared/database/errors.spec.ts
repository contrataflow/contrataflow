import { describe, expect, it } from 'vitest';

import { ApiError } from '#shared/errors/api-error.js';

import {
  DatabaseUnavailableError,
  isRetryableTransactionError,
  isTransientDatabaseError,
  isUniqueViolation,
  VersionConflictError,
} from './errors.js';

/** Formato do Prisma 7: o SQLSTATE fica em `meta.driverAdapterError.cause`. */
function adapterError(prismaCode: string, sqlState: string): Error {
  return Object.assign(new Error(`Raw query failed. Code: ${sqlState}`), {
    code: prismaCode,
    meta: {
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: { kind: 'postgres', code: sqlState, originalCode: sqlState },
      },
    },
  });
}

describe('isTransientDatabaseError', () => {
  it.each([
    ['Prisma P1001 (servidor inalcançável)', Object.assign(new Error('x'), { code: 'P1001' })],
    ['Prisma P2024 (pool esgotado)', Object.assign(new Error('x'), { code: 'P2024' })],
    [
      'ECONNREFUSED na causa',
      new Error('x', { cause: Object.assign(new Error('y'), { code: 'ECONNREFUSED' }) }),
    ],
    ['SQLSTATE 57P01 do driver adapter', adapterError('P2010', '57P01')],
    [
      'tipo do adapter DatabaseNotReachable',
      Object.assign(new Error('x'), { kind: 'DatabaseNotReachable' }),
    ],
    [
      'conexão derrubada (mensagem do pg)',
      new Error('Client has encountered a connection error and is not queryable'),
    ],
    [
      'conexão encerrada',
      new Error('x', { cause: new Error('Connection terminated unexpectedly') }),
    ],
  ])('%s → transitório', (_, error) => {
    expect(isTransientDatabaseError(error)).toBe(true);
  });

  it.each([
    ['violação de RLS (42501)', adapterError('P2039', '42501')],
    ['divisão por zero (22012)', adapterError('P2010', '22012')],
    ['ApiError da aplicação', new ApiError('VERSION_CONFLICT')],
    ['valor não-objeto', 'falhou'],
    ['nulo', null],
  ])('%s → não transitório', (_, error) => {
    expect(isTransientDatabaseError(error)).toBe(false);
  });
});

describe('isRetryableTransactionError', () => {
  it('deadlock (40P01), serialização (40001) e P2034 são retentáveis', () => {
    expect(isRetryableTransactionError(adapterError('P2010', '40P01'))).toBe(true);
    expect(isRetryableTransactionError(adapterError('P2010', '40001'))).toBe(true);
    expect(isRetryableTransactionError(Object.assign(new Error('x'), { code: 'P2034' }))).toBe(
      true,
    );
    expect(isRetryableTransactionError(adapterError('P2039', '42501'))).toBe(false);
  });
});

describe('isUniqueViolation', () => {
  it('P2002 do Prisma ou SQLSTATE 23505 do adapter; demais erros não', () => {
    expect(isUniqueViolation(Object.assign(new Error('x'), { code: 'P2002' }))).toBe(true);
    expect(isUniqueViolation(adapterError('P2010', '23505'))).toBe(true);
    expect(isUniqueViolation(adapterError('P2010', '40P01'))).toBe(false);
    expect(isUniqueViolation('texto')).toBe(false);
  });
});

describe('erros mapeados pela API', () => {
  it('VersionConflictError → 412 VERSION_CONFLICT com o alvo', () => {
    const target = { aggregateType: 'Process', aggregateId: 'p-1', expectedVersion: 3 };
    const error = new VersionConflictError(target);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 412, code: 'VERSION_CONFLICT', target });
  });

  it('DatabaseUnavailableError → 503 DEPENDENCY_UNAVAILABLE com Retry-After e a causa', () => {
    const cause = new Error('ECONNREFUSED');
    const error = new DatabaseUnavailableError(cause);
    expect(error).toMatchObject({
      status: 503,
      code: 'DEPENDENCY_UNAVAILABLE',
      headers: { 'Retry-After': '5' },
      detail: 'Não foi possível completar a operação agora. Tente novamente em instantes.',
    });
    expect(error.cause).toBe(cause);
  });
});
