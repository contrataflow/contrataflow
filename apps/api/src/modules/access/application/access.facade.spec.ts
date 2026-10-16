import { describe, expect, it } from 'vitest';

import {
  runAsSystem,
  runWithRequestContext,
  updateRequestContext,
} from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { AccessFacade } from './access.facade.js';
import type { AuthorizationService } from './authorization.service.js';
import type { SeedDefaultRolesHandler } from './seed-default-roles.handler.js';
import type { Role } from '../domain/role.js';
import { InMemoryRoleRepository } from '../infrastructure/in-memory-role.repository.js';

const roles = new InMemoryRoleRepository();
const facade = new AccessFacade({} as SeedDefaultRolesHandler, roles, {} as AuthorizationService);
const TX = {} as TenantTx;

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

  it('rolesGrant pelos perfis padrão', () => {
    expect(facade.rolesGrant(['JURIDICO'], 'APPROVAL_DECIDE')).toBe(true);
  });
});

describe('AccessFacade.findRoleForApproval / findRoleByKey (RN-DOC-07 · RN-WF-16 · US-042)', () => {
  const A = '0192a000-0000-7000-8000-00000000aaaa';
  const B = '0192a000-0000-7000-8000-00000000bbbb';
  const now = new Date('2026-10-15T12:00:00Z');
  const role = (id: string, tenantId: string, key: string, isActive = true): Role => ({
    id,
    tenantId,
    key,
    name: key,
    description: null,
    isSystem: true,
    isProtected: false,
    allowExternalAssignment: false,
    isActive,
    createdAt: now,
    updatedAt: now,
    createdById: null,
    updatedById: null,
    version: 1,
  });
  const AUTORIDADE = role('0192a000-0000-7000-8000-000000000a01', A, 'AUTORIDADE_COMPETENTE');
  const LEITURA = role('0192a000-0000-7000-8000-000000000a02', A, 'SOMENTE_LEITURA', false);
  const OUTRO = role('0192a000-0000-7000-8000-000000000b01', B, 'AUTORIDADE_COMPETENTE');
  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) =>
    runAsSystem({ name: 'test', tenantId }, fn);

  it('lê o perfil do tenant com a concessão de APPROVAL_DECIDE; outro tenant = inexistente', async () => {
    await inTenant(A, async () => {
      await roles.insertMissing(TX, [AUTORIDADE, LEITURA]);
      await roles.insertMissingGrants(TX, [
        {
          id: 'g1',
          tenantId: A,
          roleId: AUTORIDADE.id,
          permissionCode: 'APPROVAL_DECIDE',
          createdAt: now,
          createdById: null,
        },
        {
          id: 'g2',
          tenantId: A,
          roleId: LEITURA.id,
          permissionCode: 'PROCESS_VIEW',
          createdAt: now,
          createdById: null,
        },
      ]);
    });
    await inTenant(B, () => roles.insertMissing(TX, [OUTRO]));

    await inTenant(A, async () => {
      await expect(facade.findRoleForApproval(TX, AUTORIDADE.id)).resolves.toEqual({
        id: AUTORIDADE.id,
        isActive: true,
        canDecideApprovals: true,
      });
      await expect(facade.findRoleForApproval(TX, LEITURA.id)).resolves.toEqual({
        id: LEITURA.id,
        isActive: false,
        canDecideApprovals: false,
      });
      await expect(facade.findRoleForApproval(TX, OUTRO.id)).resolves.toBeNull();
      await expect(facade.findRoleByKey(TX, 'AUTORIDADE_COMPETENTE')).resolves.toMatchObject({
        id: AUTORIDADE.id,
      });
      await expect(facade.findRoleByKey(TX, 'INEXISTENTE')).resolves.toBeNull();
    });
  });
});

describe('AccessFacade.rolesCoverAllDepartments (US-102 · RN-TEN-48)', () => {
  it('perfil padrão com escopo TENANT cobre todas as unidades; OWN_DEPARTMENTS e desconhecido não', () => {
    expect(facade.rolesCoverAllDepartments(['ADMIN_ORGAO'])).toBe(true);
    expect(facade.rolesCoverAllDepartments(['REQUISITANTE', 'GESTOR_CONTRATACOES'])).toBe(true);
    expect(facade.rolesCoverAllDepartments(['REQUISITANTE'])).toBe(false);
    expect(facade.rolesCoverAllDepartments(['PERFIL_CUSTOM'])).toBe(false);
    expect(facade.rolesCoverAllDepartments([])).toBe(false);
  });
});
