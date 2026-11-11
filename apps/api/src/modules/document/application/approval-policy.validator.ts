import type { ApprovalPolicy, ApproverType, FieldError } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';

import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';

const NOT_FOUND_MESSAGE = 'Selecione um aprovador válido.';
const INACTIVE_MESSAGE = 'O aprovador selecionado não pode decidir aprovações.';
const NO_HEAD_MESSAGE = 'A unidade selecionada não tem titular cadastrado.';

const notFound = (field: string): FieldError => ({
  field,
  code: 'REFERENCE_NOT_FOUND',
  message: NOT_FOUND_MESSAGE,
});
const inactive = (field: string): FieldError => ({
  field,
  code: 'REFERENCE_INACTIVE',
  message: INACTIVE_MESSAGE,
});

/** Aprovador único da política ou uma linha da lista (mesma forma — RN-APV-04). */
interface ApproverReference {
  readonly approverType: ApproverType;
  readonly approverUserId?: string | null | undefined;
  readonly approverRoleId?: string | null | undefined;
  readonly approverDepartmentResolution?: string | null | undefined;
  readonly approverFixedDepartmentId?: string | null | undefined;
}

/**
 * RN-DOC-07: a `approvalPolicy` precisa ser resolvível NO MOMENTO da configuração — usuário com
 * vínculo `ACTIVE` e `APPROVAL_DECIDE` nas permissões efetivas (atribuições vigentes de perfil ativo,
 * com as concessões do tenant — permissions.md §1.3), perfil ativo com `APPROVAL_DECIDE`, unidade
 * fixa ativa com titular. Referência de outro tenant é indistinguível de inexistente (`REFERENCE_NOT_FOUND`, V-08).
 * As resoluções `REQUESTING_*` só podem ser verificadas na solicitação (US-051). A resolução
 * definitiva continua lá: titulares e perfis mudam depois.
 * US-132 (RN-APV-11): com `approvers[]`, cada linha é conferida (campo `approvalPolicy.approvers[n].*`);
 * o aprovador único é o espelho da linha 1 e não é conferido de novo.
 */
@Injectable()
export class ApprovalPolicyValidator {
  constructor(
    private readonly identity: IdentityFacade,
    private readonly access: AccessFacade,
    private readonly organization: OrganizationFacade,
  ) {}

  /**
   * @throws ApiError 422 `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) ou 422
   * `APPROVER_UNRESOLVED` (unidade fixa sem titular).
   */
  async assertResolvable(tx: TenantTx, policy: ApprovalPolicy, now: Date): Promise<void> {
    const lines = policy.approvers ?? [];
    if (lines.length === 0) {
      await this.assertApprover(tx, policy, 'approvalPolicy', now);
      return;
    }
    for (const [index, line] of lines.entries()) {
      await this.assertApprover(tx, line, `approvalPolicy.approvers[${String(index)}]`, now);
    }
  }

  private async assertApprover(
    tx: TenantTx,
    approver: ApproverReference,
    prefix: string,
    now: Date,
  ): Promise<void> {
    if (approver.approverType === 'USER' && approver.approverUserId) {
      const field = `${prefix}.approverUserId`;
      const [member] = await this.identity.membersInTenant(tx, [approver.approverUserId]);
      if (!member) throw validationError([notFound(field)]);
      const expired = member.expiresAt !== null && member.expiresAt.getTime() <= now.getTime();
      if (
        member.status !== 'ACTIVE' ||
        expired ||
        !(await this.access.membershipHoldsIn(tx, member, 'APPROVAL_DECIDE'))
      ) {
        throw validationError([inactive(field)]);
      }
      return;
    }
    if (approver.approverType === 'ROLE' && approver.approverRoleId) {
      const field = `${prefix}.approverRoleId`;
      const role = await this.access.findRoleForApproval(tx, approver.approverRoleId);
      if (!role) throw validationError([notFound(field)]);
      if (!role.isActive || !role.canDecideApprovals) throw validationError([inactive(field)]);
      return;
    }
    if (
      approver.approverType === 'DEPARTMENT_HEAD' &&
      approver.approverDepartmentResolution === 'FIXED' &&
      approver.approverFixedDepartmentId
    ) {
      const field = `${prefix}.approverFixedDepartmentId`;
      const department = await this.organization.findDepartmentForApproval(
        tx,
        approver.approverFixedDepartmentId,
      );
      if (!department) throw validationError([notFound(field)]);
      if (!department.isActive) throw validationError([inactive(field)]);
      if (department.headUserId === null) {
        throw new ApiError('APPROVER_UNRESOLVED', {
          detail: NO_HEAD_MESSAGE,
          errors: [{ field, code: 'REFERENCE_INACTIVE', message: NO_HEAD_MESSAGE }],
        });
      }
    }
  }
}
