import { ApprovalRequested } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { APPROVAL_REPOSITORY, PendingApprovalExistsError } from './ports.js';
import type { ApprovalRepository } from './ports.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import {
  ApproverUnresolvedError,
  resolveStageApprover,
  stageApprovalTitle,
  stageApproverDepartmentId,
} from '../domain/approval.js';
import type {
  Approval,
  RequestingUnitsOf,
  ResolvedApprover,
  StageApproverConfig,
} from '../domain/approval.js';

/** Aprovador resolvido com o rótulo exibido ("Carlos Lima (titular da Secretaria de Obras)"). */
export interface StageApprover extends ResolvedApprover {
  readonly label: string;
}

/** Documento coberto e a versão exata em análise (RN-TRAM-46). */
export interface StageCoverage {
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly documentCode: string | null;
}

export interface StageApprovalRequest {
  /** Id gerado por quem encaminha (vai em `pendingApprovalId` dos documentos no mesmo `tx`). */
  readonly approvalId: string;
  readonly processId: string;
  /** Passagem recém-aberta pela etapa `APPROVAL` (gravada antes — FK). */
  readonly processStageId: string;
  readonly stageName: string;
  readonly approver: StageApprover;
  readonly coverage: readonly StageCoverage[];
  readonly requestedById: string;
  readonly requestedAt: Date;
  readonly requestComment: string | null;
  /** RN-TRAM-51: o prazo da passagem. */
  readonly dueAt: Date | null;
}

/**
 * Aprovação de ETAPA (US-047 → US-051 · DEC-022 · RN-TRAM-43..53): o aprovador resolvido na
 * solicitação e a `Approval` `PENDING` (`subjectType = PROCESS_STAGE`) com a cobertura
 * (`ApprovalDocument`), a auditoria `approval.request` e o evento `ApprovalRequested` (timeline,
 * concessão `APPROVER` e o aviso ao aprovador), tudo no `tx` do encaminhamento — qualquer falha
 * desfaz a tramitação inteira. A submissão dos documentos cobertos é feita por quem encaminha
 * (`DocumentFacade.enterApprovalStageIn`: `document` está no mesmo nível).
 */
@Injectable()
export class StageApprovalService {
  private readonly logger = new Logger('Approval');

  constructor(
    @Inject(APPROVAL_REPOSITORY) private readonly approvals: ApprovalRepository,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly organization: OrganizationFacade,
    private readonly identity: IdentityFacade,
    private readonly access: AccessFacade,
  ) {}

  /** RN-TRAM-47..49: o aprovador da etapa e o rótulo; `null` = não resolvível. */
  async preview(
    tx: TenantTx,
    config: StageApproverConfig,
    process: RequestingUnitsOf,
  ): Promise<StageApprover | null> {
    const departmentId = stageApproverDepartmentId(config, process);
    const department =
      departmentId === null
        ? null
        : await this.organization.findDepartmentForApproval(tx, departmentId);
    let approver: ResolvedApprover;
    try {
      approver = resolveStageApprover(config, department);
    } catch (error) {
      if (error instanceof ApproverUnresolvedError) return null;
      throw error;
    }
    return { ...approver, label: await this.labelOf(tx, approver) };
  }

  /** Como `preview`, mas 422 `APPROVER_UNRESOLVED` (V-16 · FA-12) quando não resolvível. */
  async resolve(
    tx: TenantTx,
    config: StageApproverConfig,
    process: RequestingUnitsOf,
  ): Promise<StageApprover> {
    const approver = await this.preview(tx, config, process);
    if (approver === null) {
      this.logger.warn(
        {
          event: 'approval.approver_unresolved',
          approverType: config.approverType,
          correlationId: requireRequestContext().correlationId,
        },
        'approval.approver_unresolved',
      );
      throw new ApiError('APPROVER_UNRESOLVED', {
        detail: 'Não há aprovador apto para esta etapa. Fale com o administrador do órgão.',
      });
    }
    return approver;
  }

  async request(tx: TenantTx, request: StageApprovalRequest): Promise<void> {
    const tenantId = requireRequestContext().tenantId;
    if (tenantId === null) throw new ApiError('UNAUTHENTICATED');
    const { approver } = request;
    const approval: Approval = {
      id: request.approvalId,
      tenantId,
      processId: request.processId,
      subjectType: 'PROCESS_STAGE',
      processStageId: request.processStageId,
      documentId: null,
      title: stageApprovalTitle(request.stageName, request.coverage[0]?.documentCode ?? null),
      requestedById: request.requestedById,
      requestedAt: request.requestedAt,
      requestComment: request.requestComment,
      approverType: approver.approverType,
      approverUserId: approver.approverUserId,
      approverRoleId: approver.approverRoleId,
      approverDepartmentId: approver.approverDepartmentId,
      allowDeputy: approver.allowDeputy,
      dueAt: request.dueAt,
      status: 'PENDING',
      createdAt: request.requestedAt,
      createdById: request.requestedById,
    };
    if (request.coverage.length === 0) {
      // FA-02 da US-051: etapa alcançada sem documento coberto — a decisão recai só sobre a etapa.
      this.logger.warn(
        {
          event: 'approval.no_covered_documents',
          approvalId: approval.id,
          processId: approval.processId,
          correlationId: requireRequestContext().correlationId,
        },
        'approval.no_covered_documents',
      );
    }
    try {
      await this.approvals.insert(
        tx,
        approval,
        request.coverage.map((item) => ({
          id: newId(),
          documentId: item.documentId,
          documentVersionId: item.documentVersionId,
        })),
      );
    } catch (error) {
      if (error instanceof PendingApprovalExistsError) {
        throw new ApiError('INVALID_STATE', {
          detail: 'Esta etapa já tem uma aprovação em andamento.',
        });
      }
      throw error;
    }
    const documentVersionIds = request.coverage.map((item) => item.documentVersionId);
    await this.audit.record(tx, {
      action: 'approval.request',
      entityType: 'Approval',
      entityId: approval.id,
      processId: approval.processId,
      metadata: {
        subjectType: approval.subjectType,
        processStageId: approval.processStageId,
        documentIds: request.coverage.map((item) => item.documentId),
        documentVersionIds,
        approverType: approval.approverType,
        approverUserId: approval.approverUserId,
        approverRoleId: approval.approverRoleId,
        approverDepartmentId: approval.approverDepartmentId,
        allowDeputy: approval.allowDeputy,
        dueAt: approval.dueAt?.toISOString() ?? null,
      },
    });
    await this.outbox.record(
      tx,
      ApprovalRequested.of({
        aggregateId: approval.id,
        processId: approval.processId,
        payload: {
          approvalId: approval.id,
          subjectType: approval.subjectType,
          processStageId: approval.processStageId,
          documentId: null,
          documentVersionIds,
          approverType: approval.approverType,
          approverUserId: approval.approverUserId,
          approverRoleId: approval.approverRoleId,
          approverDepartmentId: approval.approverDepartmentId,
          allowDeputy: approval.allowDeputy,
          dueAt: approval.dueAt?.toISOString() ?? null,
        },
      }),
    );
  }

  /** Rótulo do aprovador: a pessoa, o perfil ou "{titular} (titular da {unidade})". */
  private async labelOf(tx: TenantTx, approver: ResolvedApprover): Promise<string> {
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
