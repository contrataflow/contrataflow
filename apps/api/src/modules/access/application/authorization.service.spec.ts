import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import type { AuthorizationRequest } from '#shared/auth/authorization.js';
import type { EffectivePermissionsSnapshot } from '#shared/auth/effective-permissions.js';
import { ProcessAccessRegistry } from '#shared/auth/process-access.js';
import {
  currentRequestContext,
  runWithRequestContext,
  updateRequestContext,
} from '#shared/context/request-context.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';

import { AuthorizationService, policyDenial, processNotFound } from './authorization.service.js';
import type { EffectivePermissionsService } from './effective-permissions.service.js';
import type { AccessTransactions } from './ports.js';
import type { IdentityFacade } from '../../identity/application/identity.facade.js';
import { InMemoryAccessTransactions } from '../infrastructure/access-transactions.js';

/* US-097 — AuthorizationService: contexto, processo, MFA e recusas (RN-IAM-100/104/105). */

const PROCESS = '0192a000-0000-7000-8000-00000000c0de';

const snapshot = (permissions: EffectivePermissionsSnapshot['grants']) =>
  ({
    membershipId: 'm1',
    userId: 'u1',
    grants: permissions,
    ownDepartmentIds: [],
    headOfDepartmentIds: [],
    computedAt: '2026-10-16T12:00:00.000Z',
  }) satisfies EffectivePermissionsSnapshot;

const TENANT_VIEW = snapshot([
  {
    scope: {
      type: 'TENANT',
      organizationId: null,
      departmentId: null,
      includeSubtree: false,
      departmentIds: [],
    },
    permissions: ['PROCESS_VIEW', 'ROLE_MANAGE'],
  },
]);

function setup(
  options: {
    readonly transactions?: AccessTransactions;
    readonly resolved?: EffectivePermissionsSnapshot;
  } = {},
) {
  const resolve = vi.fn(() => Promise.resolve(options.resolved ?? TENANT_VIEW));
  const recordStandalone = vi.fn(() => Promise.reject(new Error('auditoria fora')));
  const registry = new ProcessAccessRegistry();
  const service = new AuthorizationService(
    { resolve } as unknown as EffectivePermissionsService,
    { mfaPolicy: () => Promise.resolve('ADMINS') } as unknown as IdentityFacade,
    registry,
    options.transactions ?? new InMemoryAccessTransactions(),
    () => new Date('2026-10-16T12:00:00.000Z'),
    { recordStandalone } as unknown as AuditTrailPort,
  );
  return { service, resolve, registry, recordStandalone };
}

function asMember<T>(fn: () => Promise<T>, amr: readonly string[] = ['pwd']): Promise<T> {
  return runWithRequestContext({ correlationId: 'c', ip: '', userAgent: '' }, () => {
    updateRequestContext({
      tenantId: '0192a000-0000-7000-8000-00000000000a',
      actor: { type: 'USER', userId: 'u1', membershipId: 'm1' },
      amr,
    });
    return fn();
  });
}

const request = (patch: Partial<AuthorizationRequest> = {}): AuthorizationRequest => ({
  requirement: null,
  policies: [],
  params: {},
  resolvePolicy: () => Promise.reject(new Error('sem política')),
  ...patch,
});

describe('AuthorizationService (US-097)', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('carrega as permissões uma vez por requisição e as guarda no contexto', async () => {
    const { service, resolve } = setup();
    await asMember(async () => {
      await service.authorize(request());
      await service.current();
      expect(currentRequestContext()?.permissions).toEqual(TENANT_VIEW);
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({ membershipId: 'm1', userId: 'u1', roleKeys: [] });
  });

  it('sem vínculo (job, plataforma) não há permissão alguma', async () => {
    const { service, resolve } = setup();
    const set = await runWithRequestContext({ correlationId: 'c', ip: '', userAgent: '' }, () =>
      service.current(),
    );
    expect(set.snapshot.grants).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('permissão HIGH sem 2º fator → MFA_REQUIRED, mesmo com a auditoria auth.mfa_required fora', async () => {
    const { service, recordStandalone } = setup();
    await expect(
      asMember(() =>
        service.authorize(request({ requirement: { permission: 'ROLE_MANAGE', scope: 'ANY' } })),
      ),
    ).rejects.toMatchObject({ code: 'MFA_REQUIRED', auditReasonCode: 'MFA_REQUIRED' });
    expect(recordStandalone).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.mfa_required',
        metadata: { permissionCode: 'ROLE_MANAGE' },
      }),
    );
    await expect(
      asMember(
        () =>
          service.authorize(request({ requirement: { permission: 'ROLE_MANAGE', scope: 'ANY' } })),
        ['pwd', 'otp'],
      ),
    ).resolves.toBeUndefined();
  });

  it('sem leitor de processo registrado nenhum processo existe (falha fechada → 404)', async () => {
    const { service } = setup();
    await expect(
      asMember(() =>
        service.authorize(
          request({
            requirement: { permission: 'PROCESS_VIEW', scope: { processParam: 'id' } },
            params: { id: PROCESS },
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'PROCESS_NOT_FOUND', status: 404 });
  });

  it('parâmetro ausente ou malformado → 400 MALFORMED_REQUEST', async () => {
    const { service } = setup();
    await expect(
      asMember(() =>
        service.authorize(
          request({ requirement: { permission: 'PROCESS_VIEW', scope: { processParam: 'id' } } }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
  });

  it('banco fora ao ler o processo → 503 e error authorization.decision_failed', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const transient = Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
    const { service, registry } = setup({
      transactions: { run: () => Promise.reject(transient), read: () => Promise.reject(transient) },
    });
    registry.register({ load: () => Promise.resolve(null) });
    await expect(
      asMember(() =>
        service.authorize(
          request({
            requirement: { permission: 'PROCESS_VIEW', scope: { processParam: 'id' } },
            params: { id: PROCESS },
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(DatabaseUnavailableError);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'authorization.decision_failed',
        errorCode: 'DEPENDENCY_UNAVAILABLE',
      }),
      'authorization.decision_failed',
    );
    const bug = setup({
      transactions: {
        run: () => Promise.reject(new TypeError('bug')),
        read: () => Promise.reject(new TypeError('bug')),
      },
    });
    await expect(
      asMember(() =>
        bug.service.authorize(
          request({
            requirement: { permission: 'PROCESS_VIEW', scope: { processParam: 'id' } },
            params: { id: PROCESS },
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(TypeError);
    const apiError = setup({
      transactions: {
        run: () => Promise.reject(processNotFound()),
        read: () => Promise.reject(processNotFound()),
      },
    });
    await expect(
      asMember(() =>
        apiError.service.authorize(
          request({
            requirement: { permission: 'PROCESS_VIEW', scope: { processParam: 'id' } },
            params: { id: PROCESS },
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'PROCESS_NOT_FOUND' });
  });

  it('policyDenial: código e status da política, ou os informados, sempre auditados', () => {
    expect(policyDenial('POL-12', { allowed: false })).toMatchObject({
      code: 'LAST_ADMIN_REQUIRED',
      status: 409,
      auditReasonCode: 'POL-12',
      auditDenial: true,
    });
    expect(
      policyDenial('POL-01', { allowed: false, code: 'INVALID_PROCESS_STATUS', status: 409 }),
    ).toMatchObject({ code: 'INVALID_PROCESS_STATUS', status: 409, auditReasonCode: 'POL-01' });
    expect(
      policyDenial('POL-03', {
        allowed: false,
        code: 'SELF_APPROVAL_FORBIDDEN',
        detail: 'Você não pode aprovar o próprio documento.',
      }),
    ).toMatchObject({
      code: 'SELF_APPROVAL_FORBIDDEN',
      status: 403,
      detail: 'Você não pode aprovar o próprio documento.',
    });
  });
});
