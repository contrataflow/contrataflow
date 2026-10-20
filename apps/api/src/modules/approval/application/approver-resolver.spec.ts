import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { APPROVER_UNRESOLVED_MESSAGES, ApproverResolver } from './approver-resolver.js';
import type { AccessFacade } from '../../access/application/access.facade.js';
import type { IdentityFacade, TenantMember } from '../../identity/application/identity.facade.js';
import type {
  DepartmentForApproval,
  OrganizationFacade,
} from '../../organization/application/organization.facade.js';
import type { ApproverConfig } from '../domain/approval.js';

/* US-051 — resolução do aprovador com as leituras do `tx` (unidade, vínculo, detentores do perfil). */

const id = (n: number) => `0192f051-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const TENANT = id(1);
const PROCESS = {
  organizationId: id(2),
  requestingSecretariatId: id(3),
  requestingDepartmentId: id(4),
};
const HEAD = id(10);
const USER = id(11);
const ROLE = id(12);
const NOW = new Date('2026-10-18T12:00:00.000Z');
const TX = {} as TenantTx;

const config = (overrides: Partial<ApproverConfig>): ApproverConfig => ({
  approverType: 'DEPARTMENT_HEAD',
  approverUserId: null,
  approverRoleId: null,
  approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
  approverFixedDepartmentId: null,
  ...overrides,
});

function resolver(
  options: {
    readonly department?: DepartmentForApproval | null;
    readonly members?: readonly Partial<TenantMember>[];
    readonly holders?: readonly string[];
  } = {},
) {
  const holderQueries: unknown[] = [];
  const organization = {
    findDepartmentForApproval: () =>
      Promise.resolve(
        options.department === undefined
          ? {
              id: PROCESS.requestingSecretariatId,
              isActive: true,
              headUserId: HEAD,
              deputyUserId: null,
            }
          : options.department,
      ),
    departmentNames: (_tx: TenantTx, ids: readonly string[]) =>
      Promise.resolve(new Map(ids.map((unit) => [unit, 'Secretaria de Obras']))),
  } as unknown as OrganizationFacade;
  const identity = {
    membersInTenant: (_tx: TenantTx, userIds: readonly string[]) =>
      Promise.resolve(
        (options.members ?? userIds.map((userId) => ({ userId }))).map((member): TenantMember => ({
          userId: member.userId ?? '',
          membershipId: id(99),
          type: 'INTERNAL',
          status: 'ACTIVE',
          expiresAt: null,
          roleKeys: [],
          ...member,
        })),
      ),
    userDisplayNames: (_tx: TenantTx, userIds: readonly string[]) =>
      Promise.resolve(new Map(userIds.map((userId) => [userId, `Pessoa ${userId.slice(-2)}`]))),
  } as unknown as IdentityFacade;
  const access = {
    roleHoldersInScopeIn: (...args: unknown[]) => {
      holderQueries.push(args.slice(1));
      return Promise.resolve([...(options.holders ?? [USER])]);
    },
    roleSummaries: (_tx: TenantTx, ids: readonly string[]) =>
      Promise.resolve(
        new Map(ids.map((role) => [role, { key: 'AUTORIDADE', name: 'Autoridade' }])),
      ),
  } as unknown as AccessFacade;
  return { approvers: new ApproverResolver(organization, identity, access), holderQueries };
}

const inContext = <T>(work: () => Promise<T>) =>
  runWithRequestContext({ correlationId: 'corr-051', ip: '', userAgent: '' }, () => {
    updateRequestContext({ tenantId: TENANT });
    return work();
  });

async function refusal(work: () => Promise<unknown>): Promise<ApiError> {
  try {
    await work();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('esperava ApiError');
}

describe('ApproverResolver', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('DEPARTMENT_HEAD: titular com vínculo ativo, com substituto e o rótulo "{titular} (titular da {unidade})"', async () => {
    const { approvers } = resolver();
    await expect(approvers.preview(TX, config({}), PROCESS, NOW)).resolves.toEqual({
      approverType: 'DEPARTMENT_HEAD',
      approverUserId: HEAD,
      approverRoleId: null,
      approverDepartmentId: PROCESS.requestingSecretariatId,
      allowDeputy: true,
      label: `Pessoa ${HEAD.slice(-2)} (titular da Secretaria de Obras)`,
    });
  });

  it('USER e ROLE: rótulos da pessoa e do perfil; ROLE consulta a competência sobre a unidade solicitante', async () => {
    const { approvers, holderQueries } = resolver();
    await expect(
      approvers.preview(TX, config({ approverType: 'USER', approverUserId: USER }), PROCESS, NOW),
    ).resolves.toMatchObject({ approverUserId: USER, label: `Pessoa ${USER.slice(-2)}` });
    await expect(
      approvers.preview(TX, config({ approverType: 'ROLE', approverRoleId: ROLE }), PROCESS, NOW),
    ).resolves.toMatchObject({ approverRoleId: ROLE, label: 'Autoridade' });
    expect(holderQueries).toEqual([
      [
        ROLE,
        {
          organizationId: PROCESS.organizationId,
          departmentIds: [PROCESS.requestingSecretariatId, PROCESS.requestingDepartmentId],
        },
        NOW,
      ],
    ]);
  });

  it('prévia sem aprovador → null, sem log', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { approvers } = resolver({ department: null });
    await expect(approvers.preview(TX, config({}), PROCESS, NOW)).resolves.toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it('titular com vínculo vencido ou de outro tenant → 422 APPROVER_UNRESOLVED com a mensagem do assunto', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const expired = resolver({
      members: [{ userId: HEAD, expiresAt: new Date('2026-06-01T00:00:00.000Z') }],
    });
    const stage = await inContext(() =>
      refusal(() => expired.approvers.resolve(TX, config({}), PROCESS, NOW, 'PROCESS_STAGE')),
    );
    expect(stage).toMatchObject({
      code: 'APPROVER_UNRESOLVED',
      status: 422,
      detail: APPROVER_UNRESOLVED_MESSAGES.PROCESS_STAGE,
    });
    const foreign = resolver({ members: [] });
    const document = await inContext(() =>
      refusal(() => foreign.approvers.resolve(TX, config({}), PROCESS, NOW, 'DOCUMENT')),
    );
    expect(document.detail).toBe(APPROVER_UNRESOLVED_MESSAGES.DOCUMENT);
  });

  it('perfil sem detentor: warn approval.role_scope_empty e error approval.request_failed, sem dados pessoais', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { approvers } = resolver({ holders: [] });
    const refused = await inContext(() =>
      refusal(() =>
        approvers.resolve(
          TX,
          config({ approverType: 'ROLE', approverRoleId: ROLE }),
          PROCESS,
          NOW,
          'PROCESS_STAGE',
        ),
      ),
    );
    expect(refused.code).toBe('APPROVER_UNRESOLVED');
    expect(warn).toHaveBeenCalledWith(
      {
        event: 'approval.role_scope_empty',
        subjectType: 'PROCESS_STAGE',
        approverRoleId: ROLE,
        correlationId: 'corr-051',
      },
      'approval.role_scope_empty',
    );
    expect(error).toHaveBeenCalledWith(
      {
        event: 'approval.request_failed',
        errorCode: 'APPROVER_UNRESOLVED',
        cause: 'ROLE_SCOPE_EMPTY',
        subjectType: 'PROCESS_STAGE',
        approverType: 'ROLE',
        correlationId: 'corr-051',
      },
      'approval.request_failed',
    );
  });

  it('resolve com aprovador: devolve o mesmo que a prévia', async () => {
    const { approvers } = resolver();
    await expect(
      inContext(() => approvers.resolve(TX, config({}), PROCESS, NOW, 'DOCUMENT')),
    ).resolves.toMatchObject({ approverUserId: HEAD, allowDeputy: true });
  });
});
