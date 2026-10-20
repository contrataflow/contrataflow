import { describe, expect, it } from 'vitest';

import { ApiError } from '#shared/errors/api-error.js';

import {
  DatabaseUnavailableError,
  isForeignKeyViolation,
  isRetryableTransactionError,
  isRowLevelSecurityViolation,
  isTransientDatabaseError,
  isUniqueViolation,
  referenceNotFound,
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

describe('tradução de SQLSTATE do isolamento (US-100 · RN-TEN-33)', () => {
  it('23503 (FK composta) → 422 VALIDATION_ERROR com REFERENCE_NOT_FOUND no campo da FK', () => {
    const error = Object.assign(
      new Error(
        'insert or update on table "membership_departments" violates foreign key constraint ' +
          '"membership_departments_tenant_id_membership_id_fkey"',
      ),
      {
        code: 'P2010',
        meta: {
          driverAdapterError: {
            cause: {
              code: '23503',
              detail:
                'Key (tenant_id, membership_id)=(0192…, 0192…) is not present in table "tenant_memberships".',
            },
          },
        },
      },
    );
    expect(isForeignKeyViolation(error)).toBe(true);
    expect(isForeignKeyViolation(adapterError('P2010', '23505'))).toBe(false);
    const translated = referenceNotFound(error);
    expect(translated).toMatchObject({
      status: 422,
      code: 'VALIDATION_ERROR',
      errors: [{ field: 'membershipId', code: 'REFERENCE_NOT_FOUND' }],
    });
  });

  it('campos do driver adapter (P2003) e FK sem colunas conhecidas', () => {
    const prisma = Object.assign(new Error('Foreign key constraint violated'), {
      code: 'P2003',
      meta: {
        driverAdapterError: {
          cause: {
            kind: 'ForeignKeyConstraintViolation',
            constraint: { fields: ['tenant_id', 'requesting_department_id'] },
          },
        },
      },
    });
    expect(isForeignKeyViolation(prisma)).toBe(true);
    expect(referenceNotFound(prisma).errors).toEqual([
      expect.objectContaining({ field: 'requestingDepartmentId', code: 'REFERENCE_NOT_FOUND' }),
    ]);
    // Formato real do Prisma 7 (P2003): só o nome da restrição e a mensagem com a tabela.
    const named = Object.assign(new Error('Foreign key constraint violated'), {
      code: 'P2003',
      meta: {
        driverAdapterError: {
          cause: {
            originalCode: '23503',
            originalMessage:
              'insert or update on table "membership_departments" violates foreign key constraint ' +
              '"membership_departments_tenant_id_membership_id_fkey"',
            kind: 'ForeignKeyConstraintViolation',
            constraint: { index: 'membership_departments_tenant_id_membership_id_fkey' },
          },
        },
      },
    });
    expect(referenceNotFound(named).errors[0]?.field).toBe('membershipId');
    const simple = Object.assign(new Error('fk'), {
      code: '23503',
      constraint: { index: 'processes_created_by_id_fkey' },
      originalMessage: 'insert or update on table "processes" violates foreign key constraint',
    });
    expect(referenceNotFound(simple).errors[0]?.field).toBe('createdById');
    const bare = Object.assign(new Error('fk'), { code: '23503' });
    expect(referenceNotFound(bare).errors[0]?.field).toBe('reference');
    expect(isForeignKeyViolation(new ApiError('VALIDATION_ERROR'))).toBe(false);
  });

  it('42501 da RLS é reconhecida; falta de privilégio comum não é violação de RLS', () => {
    const rls = Object.assign(adapterError('P2010', '42501'), {
      message: 'new row violates row-level security policy for table "outbox_events"',
    });
    expect(isRowLevelSecurityViolation(rls)).toBe(true);
    const privilege = Object.assign(adapterError('P2010', '42501'), {
      message: 'permission denied for table outbox_events',
    });
    expect(isRowLevelSecurityViolation(privilege)).toBe(false);
    expect(isRowLevelSecurityViolation(new ApiError('INTERNAL_ERROR'))).toBe(false);
  });
});
