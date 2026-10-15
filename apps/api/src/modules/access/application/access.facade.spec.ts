import { describe, expect, it } from 'vitest';

import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { AccessFacade } from './access.facade.js';

const facade = new AccessFacade();

function as<T>(roleKeys: readonly string[], amr: readonly string[], fn: () => T): T {
  return runWithRequestContext({ correlationId: 'c', ip: '', userAgent: '' }, () => {
    updateRequestContext({ roleKeys, amr });
    return fn();
  });
}

function thrown(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('não lançou');
}

describe('AccessFacade.assertCan (POL-14)', () => {
  it('administrador com MFA passa', () => {
    expect(() => {
      as(['ADMIN_ORGAO'], ['pwd', 'otp'], () => {
        facade.assertCan('DOCUMENT_TYPE_MANAGE', { mfaPolicy: 'ADMINS' });
      });
    }).not.toThrow();
  });

  it('sem a permissão → PERMISSION_DENIED com a permissão como motivo auditado', () => {
    const error = thrown(() => {
      as(['GESTOR_CONTRATACOES'], ['pwd', 'otp'], () => {
        facade.assertCan('DOCUMENT_TYPE_MANAGE', { mfaPolicy: 'ADMINS' });
      });
    });
    expect(error).toMatchObject({
      code: 'PERMISSION_DENIED',
      status: 403,
      auditReasonCode: 'DOCUMENT_TYPE_MANAGE',
    });
  });

  it('a permissão vem antes do MFA: sem permissão e sem MFA, a recusa é de permissão', () => {
    const error = thrown(() => {
      as([], ['pwd'], () => {
        facade.assertCan('DOCUMENT_TYPE_MANAGE', { mfaPolicy: 'ADMINS' });
      });
    });
    expect(error.code).toBe('PERMISSION_DENIED');
  });

  it.each(['ADMINS', 'ALL'] as const)(
    'com a política %s, sem segundo fator → MFA_REQUIRED',
    (policy) => {
      const error = thrown(() => {
        as(['ADMIN_ORGAO'], ['pwd'], () => {
          facade.assertCan('DOCUMENT_TYPE_MANAGE', { mfaPolicy: policy });
        });
      });
      expect(error).toMatchObject({ code: 'MFA_REQUIRED', status: 403 });
    },
  );

  it('com a política NONE o MFA não é cobrado', () => {
    expect(() => {
      as(['ADMIN_ORGAO'], ['pwd'], () => {
        facade.assertCan('DOCUMENT_TYPE_MANAGE', { mfaPolicy: 'NONE' });
      });
    }).not.toThrow();
  });

  it('rolesGrant e findRoleForApproval (perfis como registro: US-094)', async () => {
    expect(facade.rolesGrant(['JURIDICO'], 'APPROVAL_DECIDE')).toBe(true);
    await expect(facade.findRoleForApproval({} as TenantTx, 'x')).resolves.toBeNull();
  });
});
