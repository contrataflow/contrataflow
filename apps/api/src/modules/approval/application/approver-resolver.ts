import { approverLineLabel, MULTI_APPROVAL_MESSAGES } from '@contrataflow/validation';
import { Injectable, Logger } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { recordApprovalRequestFailed } from './approval-telemetry.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import type {
  ApprovalLineConfig,
  ApprovalRequestConfig,
  ResolvedApprovalLine,
} from '../domain/approval-lines.js';
import {
  approverCandidateIds,
  approverDepartmentId,
  ApproverUnresolvedError,
  resolveApprover,
} from '../domain/approval.js';
import type {
  ApprovalSubjectType,
  ApproverConfig,
  ApproverDepartment,
  ApproverFacts,
  RequestingUnitsOf,
  ResolvedApprover,
} from '../domain/approval.js';

/** Aprovador resolvido com o rótulo exibido ("Carlos Lima (titular da Secretaria de Obras)"). */
export interface StageApprover extends ResolvedApprover {
  readonly label: string;
}

/** Unidade aprovadora lida uma vez por solicitação (titular, substituto e situação). */
interface ApprovalUnit extends ApproverDepartment {
  readonly deputyUserId: string | null;
}

/** As linhas resolvidas e o que a segregação precisa das unidades (US-133). */
export interface ResolvedApprovalLines {
  readonly lines: readonly ResolvedApprovalLine[];
  /** Substituto com vínculo ativo de cada unidade das linhas `DEPARTMENT_HEAD` (RN-APV-20). */
  readonly deputies: ReadonlyMap<string, string | null>;
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

  /**
   * US-133 (RN-APV-19): cada linha, em ordem de `sequence`, com as regras da US-051 — em lote: uma
   * leitura por unidade, uma dos vínculos de todos os candidatos e uma por perfil. Linha sem
   * aprovador → 422 `APPROVER_UNRESOLVED` com `meta.sequence`/`meta.approverLabel` (rótulo da
   * linha, nunca o nome de quem seria o aprovador), que desfaz a ação de origem inteira.
   */
  async resolveLines(
    tx: TenantTx,
    config: ApprovalRequestConfig,
    process: RequestingUnitsOf,
    now: Date,
    subjectType: ApprovalSubjectType,
  ): Promise<ResolvedApprovalLines> {
    const units = new Map<string, ApprovalUnit | null>();
    for (const line of config.lines) {
      const departmentId = approverDepartmentId(line, process);
      if (departmentId === null || units.has(departmentId)) continue;
      units.set(departmentId, await this.organization.findDepartmentForApproval(tx, departmentId));
    }
    const candidates = new Set<string>();
    for (const line of config.lines) {
      const departmentId = approverDepartmentId(line, process);
      const unit = departmentId === null ? null : (units.get(departmentId) ?? null);
      for (const id of approverCandidateIds(line, unit)) candidates.add(id);
      if (unit?.deputyUserId) candidates.add(unit.deputyUserId);
    }
    const activeMemberIds = await this.activeMembers(tx, [...candidates], now);
    const holders = new Map<string, readonly string[]>();
    for (const line of config.lines) {
      const roleId = line.approverType === 'ROLE' ? line.approverRoleId : null;
      if (roleId === null || holders.has(roleId)) continue;
      holders.set(
        roleId,
        await this.access.roleHoldersInScopeIn(
          tx,
          roleId,
          {
            organizationId: process.organizationId,
            departmentIds: [process.requestingSecretariatId, process.requestingDepartmentId],
          },
          now,
        ),
      );
    }
    const lines = config.lines.map((line): ResolvedApprovalLine => {
      const departmentId = approverDepartmentId(line, process);
      const facts: ApproverFacts = {
        department: departmentId === null ? null : (units.get(departmentId) ?? null),
        activeMemberIds,
        roleHolderIds:
          line.approverType === 'ROLE' && line.approverRoleId !== null
            ? (holders.get(line.approverRoleId) ?? [])
            : [],
      };
      try {
        return {
          ...resolveApprover(line, facts),
          sequence: line.sequence,
          configuredLabel: line.label,
        };
      } catch (error) {
        if (!(error instanceof ApproverUnresolvedError)) throw error;
        throw this.lineUnresolved(error, line, config, subjectType);
      }
    });
    const deputies = new Map<string, string | null>();
    for (const [id, unit] of units) {
      const deputy = unit?.deputyUserId ?? null;
      deputies.set(id, deputy !== null && activeMemberIds.has(deputy) ? deputy : null);
    }
    return { lines, deputies };
  }

  private lineUnresolved(
    error: ApproverUnresolvedError,
    line: ApprovalLineConfig,
    config: ApprovalRequestConfig,
    subjectType: ApprovalSubjectType,
  ): ApiError {
    const { correlationId } = requireRequestContext();
    if (error.reason === 'ROLE_SCOPE_EMPTY') {
      this.logger.warn(
        {
          event: 'approval.role_scope_empty',
          subjectType,
          approverRoleId: line.approverRoleId,
          sequence: line.sequence,
          correlationId,
        },
        'approval.role_scope_empty',
      );
    }
    this.logger.warn(
      {
        event: 'approval.request_rejected',
        reason: 'APPROVER_UNRESOLVED',
        cause: error.reason,
        subjectType,
        sequence: line.sequence,
        correlationId,
      },
      'approval.request_rejected',
    );
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
    const approverLabel = approverLineLabel(line.approverType, line.label);
    return new ApiError('APPROVER_UNRESOLVED', {
      // FA-01: sem lista configurada, a mensagem do MVP 1 (US-051).
      detail: config.listed
        ? MULTI_APPROVAL_MESSAGES.lineUnresolved(subjectType, line.sequence, approverLabel)
        : APPROVER_UNRESOLVED_MESSAGES[subjectType],
      extensions: { meta: { sequence: line.sequence, approverLabel } },
    });
  }

  /** Usuários com vínculo `ACTIVE` não vencido no tenant (RN-TRAM-49), numa leitura. */
  /**
   * US-135 (RN-APV-53 · RN-APV-20): o substituto da unidade com vínculo ativo — o desvio da linha
   * redirecionada para o titular autor de documento coberto. `null` = sem substituto elegível.
   */
  async activeDeputyOf(tx: TenantTx, departmentId: string, now: Date): Promise<string | null> {
    const unit = await this.organization.findDepartmentForApproval(tx, departmentId);
    const deputy = unit?.deputyUserId ?? null;
    if (deputy === null) return null;
    return (await this.activeMembers(tx, [deputy], now)).has(deputy) ? deputy : null;
  }

  private async activeMembers(
    tx: TenantTx,
    userIds: readonly string[],
    now: Date,
  ): Promise<ReadonlySet<string>> {
    if (userIds.length === 0) return new Set();
    const members = await this.identity.membersInTenant(tx, userIds);
    return new Set(
      members
        .filter(
          (member) =>
            member.status === 'ACTIVE' &&
            (member.expiresAt === null || member.expiresAt.getTime() > now.getTime()),
        )
        .map((member) => member.userId),
    );
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
        // US-133 (RN-APV-20): linha desviada do titular autor para o substituto (`allowDeputy`
        // falso só acontece aí — o titular sempre aceita substituto, RN-TRAM-48).
        if (!approver.allowDeputy && head !== null) {
          return `${head} (em substituição ao titular da ${department})`;
        }
        return head === null ? `Titular da ${department}` : `${head} (titular da ${department})`;
      }
    }
  }
}
