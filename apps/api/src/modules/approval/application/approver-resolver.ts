import { Injectable, Logger } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { recordApprovalRequestFailed } from './approval-telemetry.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import {
  approverCandidateIds,
  approverDepartmentId,
  ApproverUnresolvedError,
  resolveApprover,
} from '../domain/approval.js';
import type {
  ApprovalSubjectType,
  ApproverConfig,
  ApproverFacts,
  RequestingUnitsOf,
  ResolvedApprover,
} from '../domain/approval.js';

/** Aprovador resolvido com o rótulo exibido ("Carlos Lima (titular da Secretaria de Obras)"). */
export interface StageApprover extends ResolvedApprover {
  readonly label: string;
}

/** V-02 da US-051 (FA-03): a mensagem da etapa e a da submissão avulsa. */
export const APPROVER_UNRESOLVED_MESSAGES: Readonly<Record<ApprovalSubjectType, string>> = {
  PROCESS_STAGE: 'Não há aprovador configurado para esta etapa. Fale com o administrador do órgão.',
  DOCUMENT:
    'Não há aprovador configurado para este tipo de documento. Fale com o administrador do órgão.',
};

/**
 * Resolução do aprovador (US-051 · DEC-022 · RN-TRAM-47..49), a mesma na prévia do PRC-08, no
 * encaminhamento (PRC-19) e na submissão avulsa (DOC-09): lê no `tx` do chamador a unidade
 * aprovadora, o vínculo do aprovador `USER`/titular e os detentores competentes do perfil `ROLE`
 * (`AccessFacade.roleHoldersInScopeIn`) e aplica `resolveApprover`. Tudo pela RLS do tenant da
 * transação: unidade, titular ou detentor de outro tenant simplesmente não existem aqui.
 */
@Injectable()
export class ApproverResolver {
  private readonly logger = new Logger('Approval');

  constructor(
    private readonly organization: OrganizationFacade,
    private readonly identity: IdentityFacade,
    private readonly access: AccessFacade,
  ) {}

  /** O aprovador e o rótulo; `null` = não resolvível (prévia — sem log). */
  async preview(
    tx: TenantTx,
    config: ApproverConfig,
    process: RequestingUnitsOf,
    now: Date,
  ): Promise<StageApprover | null> {
    const facts = await this.factsOf(tx, config, process, now);
    try {
      const approver = resolveApprover(config, facts);
      return { ...approver, label: await this.labelOf(tx, approver) };
    } catch (error) {
      if (error instanceof ApproverUnresolvedError) return null;
      throw error;
    }
  }

  /**
   * Como `preview`, mas sem aprovador → 422 `APPROVER_UNRESOLVED` (V-02 · RN-TRAM-49), que desfaz
   * a ação de origem inteira; `warn approval.role_scope_empty` quando o perfil não tem detentor.
   */
  async resolve(
    tx: TenantTx,
    config: ApproverConfig,
    process: RequestingUnitsOf,
    now: Date,
    subjectType: ApprovalSubjectType,
  ): Promise<StageApprover> {
    const facts = await this.factsOf(tx, config, process, now);
    let approver: ResolvedApprover;
    try {
      approver = resolveApprover(config, facts);
    } catch (error) {
      if (!(error instanceof ApproverUnresolvedError)) throw error;
      const { correlationId } = requireRequestContext();
      if (error.reason === 'ROLE_SCOPE_EMPTY') {
        this.logger.warn(
          {
            event: 'approval.role_scope_empty',
            subjectType,
            approverRoleId: config.approverRoleId,
            correlationId,
          },
          'approval.role_scope_empty',
        );
      }
      this.logger.error(
        {
          event: 'approval.request_failed',
          errorCode: 'APPROVER_UNRESOLVED',
          cause: error.reason,
          subjectType,
          approverType: error.approverType,
          correlationId,
        },
        'approval.request_failed',
      );
      recordApprovalRequestFailed(subjectType, 'APPROVER_UNRESOLVED');
      throw new ApiError('APPROVER_UNRESOLVED', {
        detail: APPROVER_UNRESOLVED_MESSAGES[subjectType],
      });
    }
    return { ...approver, label: await this.labelOf(tx, approver) };
  }

  private async factsOf(
    tx: TenantTx,
    config: ApproverConfig,
    process: RequestingUnitsOf,
    now: Date,
  ): Promise<ApproverFacts> {
    // Em sequência: a transação interativa executa uma consulta por vez.
    const departmentId = approverDepartmentId(config, process);
    const department =
      departmentId === null
        ? null
        : await this.organization.findDepartmentForApproval(tx, departmentId);
    const candidates = approverCandidateIds(config, department);
    const members =
      candidates.length === 0 ? [] : await this.identity.membersInTenant(tx, candidates);
    const activeMemberIds = new Set(
      members
        .filter(
          (member) =>
            member.status === 'ACTIVE' &&
            (member.expiresAt === null || member.expiresAt.getTime() > now.getTime()),
        )
        .map((member) => member.userId),
    );
    const roleHolderIds =
      config.approverType === 'ROLE' && config.approverRoleId !== null
        ? await this.access.roleHoldersInScopeIn(
            tx,
            config.approverRoleId,
            {
              organizationId: process.organizationId,
              departmentIds: [process.requestingSecretariatId, process.requestingDepartmentId],
            },
            now,
          )
        : [];
    return { department, activeMemberIds, roleHolderIds };
  }

  /**
   * Rótulo do aprovador: a pessoa, o perfil ou "{titular} (titular da {unidade})" — também o do
   * detalhe da aprovação (APV-02 — US-052).
   */
  async labelOf(tx: TenantTx, approver: ResolvedApprover): Promise<string> {
    const userName = async (userId: string | null) =>
      userId === null
        ? null
        : ((await this.identity.userDisplayNames(tx, [userId])).get(userId) ?? null);
    switch (approver.approverType) {
      case 'USER':
        return (await userName(approver.approverUserId)) ?? 'Aprovador designado';
      case 'ROLE': {
        const roleId = approver.approverRoleId ?? '';
        return (
          (await this.access.roleSummaries(tx, [roleId])).get(roleId)?.name ?? 'Perfil aprovador'
        );
      }
      case 'DEPARTMENT_HEAD': {
        const departmentId = approver.approverDepartmentId ?? '';
        const department =
          (await this.organization.departmentNames(tx, [departmentId])).get(departmentId) ??
          'unidade';
        const head = await userName(approver.approverUserId);
        return head === null ? `Titular da ${department}` : `${head} (titular da ${department})`;
      }
    }
  }
}
