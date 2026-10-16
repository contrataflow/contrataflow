import type { ApprovalPolicy } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { ApprovalPolicyValidator } from './approval-policy.validator.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import type { RoleForApproval } from '../../access/application/access.facade.js';
import type { IdentityFacade, TenantMember } from '../../identity/application/identity.facade.js';
import type {
  OrganizationFacade,
  DepartmentForApproval,
} from '../../organization/application/organization.facade.js';

const USER = '0192f000-0000-7000-8000-0000000000a1';
const ROLE = '0192f000-0000-7000-8000-0000000000b1';
const DEPARTMENT = '0192f000-0000-7000-8000-0000000000d1';
const NOW = new Date('2026-10-15T12:00:00.000Z');
const tx = {} as TenantTx;

function validator(options: {
  member?: Partial<TenantMember> | null;
  role?: RoleForApproval | null;
  department?: DepartmentForApproval | null;
}) {
  const identity = {
    membersInTenant: () =>
      Promise.resolve(
        options.member
          ? [
              {
                userId: USER,
                membershipId: 'm',
                status: 'ACTIVE',
                expiresAt: null,
                roleKeys: ['GESTOR_CONTRATACOES'],
                ...options.member,
              },
            ]
          : [],
      ),
  } as unknown as IdentityFacade;
  const access = Object.assign(
    new AccessFacade(
      {} as ConstructorParameters<typeof AccessFacade>[0],
      {} as ConstructorParameters<typeof AccessFacade>[1],
      {} as ConstructorParameters<typeof AccessFacade>[2],
    ),
    {
      findRoleForApproval: () => Promise.resolve(options.role ?? null),
    },
  );
  const organization = {
    findDepartmentForApproval: () => Promise.resolve(options.department ?? null),
  } as unknown as OrganizationFacade;
  return new ApprovalPolicyValidator(identity, access, organization);
}

async function outcome(promise: Promise<unknown>): Promise<ApiError | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
}

const user: ApprovalPolicy = { approverType: 'USER', approverUserId: USER, allowDeputy: true };
const role: ApprovalPolicy = { approverType: 'ROLE', approverRoleId: ROLE, allowDeputy: true };
const fixed: ApprovalPolicy = {
  approverType: 'DEPARTMENT_HEAD',
  approverDepartmentResolution: 'FIXED',
  approverFixedDepartmentId: DEPARTMENT,
  allowDeputy: true,
};

describe('ApprovalPolicyValidator (RN-DOC-07 · V-08/V-09/V-10)', () => {
  it('USER: vínculo ativo com APPROVAL_DECIDE resolve', async () => {
    expect(await outcome(validator({ member: {} }).assertResolvable(tx, user, NOW))).toBeNull();
  });

  it.each([
    ['vínculo suspenso', { status: 'SUSPENDED' as const }],
    ['vínculo expirado', { expiresAt: new Date('2026-01-01T00:00:00Z') }],
    ['perfis sem APPROVAL_DECIDE', { roleKeys: ['ADMIN_ORGAO'] }],
  ])('USER: %s → REFERENCE_INACTIVE', async (_name, member) => {
    const error = await outcome(validator({ member }).assertResolvable(tx, user, NOW));
    expect(error).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(error?.errors).toEqual([
      expect.objectContaining({
        field: 'approvalPolicy.approverUserId',
        code: 'REFERENCE_INACTIVE',
        message: 'O aprovador selecionado não pode decidir aprovações.',
      }),
    ]);
  });

  it('USER sem vínculo no tenant → REFERENCE_NOT_FOUND', async () => {
    const error = await outcome(validator({ member: null }).assertResolvable(tx, user, NOW));
    expect(error?.errors).toEqual([
      expect.objectContaining({
        field: 'approvalPolicy.approverUserId',
        code: 'REFERENCE_NOT_FOUND',
        message: 'Selecione um aprovador válido.',
      }),
    ]);
  });

  it('ROLE: perfil ativo com APPROVAL_DECIDE resolve; inativo, sem a permissão ou inexistente não', async () => {
    const ok = { id: ROLE, isActive: true, canDecideApprovals: true };
    expect(await outcome(validator({ role: ok }).assertResolvable(tx, role, NOW))).toBeNull();
    for (const bad of [
      { ...ok, isActive: false },
      { ...ok, canDecideApprovals: false },
    ]) {
      const error = await outcome(validator({ role: bad }).assertResolvable(tx, role, NOW));
      expect(error?.errors[0]).toMatchObject({
        field: 'approvalPolicy.approverRoleId',
        code: 'REFERENCE_INACTIVE',
      });
    }
    const missing = await outcome(validator({ role: null }).assertResolvable(tx, role, NOW));
    expect(missing?.errors[0]).toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
  });

  it('DEPARTMENT_HEAD FIXED: unidade ativa com titular resolve; sem titular → APPROVER_UNRESOLVED (422)', async () => {
    const withHead = { id: DEPARTMENT, isActive: true, headUserId: USER };
    expect(
      await outcome(validator({ department: withHead }).assertResolvable(tx, fixed, NOW)),
    ).toBeNull();
    const noHead = await outcome(
      validator({ department: { ...withHead, headUserId: null } }).assertResolvable(tx, fixed, NOW),
    );
    expect(noHead).toMatchObject({
      code: 'APPROVER_UNRESOLVED',
      status: 422,
      detail: 'A unidade selecionada não tem titular cadastrado.',
    });
    const off = await outcome(
      validator({ department: { ...withHead, isActive: false } }).assertResolvable(tx, fixed, NOW),
    );
    expect(off?.errors[0]).toMatchObject({ code: 'REFERENCE_INACTIVE' });
    const missing = await outcome(validator({}).assertResolvable(tx, fixed, NOW));
    expect(missing?.errors[0]).toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
  });

  it('REQUESTING_*: só verificável na solicitação (US-051) — nada a consultar agora', async () => {
    for (const resolution of ['REQUESTING_SECRETARIAT', 'REQUESTING_DEPARTMENT'] as const) {
      const policy: ApprovalPolicy = {
        approverType: 'DEPARTMENT_HEAD',
        approverDepartmentResolution: resolution,
        allowDeputy: false,
      };
      expect(await outcome(validator({}).assertResolvable(tx, policy, NOW))).toBeNull();
    }
  });
});
