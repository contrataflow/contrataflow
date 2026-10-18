import type { ApproverType } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { APPROVAL_REPOSITORY } from './ports.js';
import type { ApprovalRepository } from './ports.js';
import { StageApprovalService } from './stage-approval.service.js';
import type { StageApprovalRequest, StageApprover } from './stage-approval.service.js';
import type { RequestingUnitsOf, StageApproverConfig } from '../domain/approval.js';

export type {
  StageApprovalRequest,
  StageApprover,
  StageCoverage,
} from './stage-approval.service.js';
export type { RequestingUnitsOf, StageApproverConfig } from '../domain/approval.js';

/** Aprovação pendente como o painel situacional a mostra (US-004 · RN-PROC-48(2)/(7)). */
export interface PendingApprovalFact {
  readonly id: string;
  readonly title: string;
  readonly processStageId: string | null;
  readonly documentId: string | null;
  readonly approverType: ApproverType;
  readonly approverUserId: string | null;
  readonly approverRoleId: string | null;
  readonly approverDepartmentId: string | null;
  readonly allowDeputy: boolean;
  readonly requestedAt: Date;
  readonly dueAt: Date | null;
}

/**
 * API pública do módulo `approval` para os demais módulos (DEC-041): métodos de intenção,
 * nunca exposição de repositório. US-004: as aprovações pendentes do processo para o painel.
 */
@Injectable()
export class ApprovalFacade {
  constructor(
    @Inject(APPROVAL_REPOSITORY) private readonly approvals: ApprovalRepository,
    private readonly stageApprovals: StageApprovalService,
  ) {}

  /**
   * Prévia do aprovador da etapa `APPROVAL` (US-047 · PRC-08 `approverPreview`): resolvido como na
   * solicitação, com o rótulo; `null` = não resolvível (`APPROVER_UNRESOLVED` no encaminhamento).
   */
  previewStageApproverIn(
    tx: TenantTx,
    config: StageApproverConfig,
    process: RequestingUnitsOf,
  ): Promise<StageApprover | null> {
    return this.stageApprovals.preview(tx, config, process);
  }

  /**
   * RN-TRAM-47..49: o aprovador da etapa `APPROVAL` resolvido NA solicitação, no `tx` do
   * encaminhamento. @throws ApiError 422 `APPROVER_UNRESOLVED`
   */
  resolveStageApproverIn(
    tx: TenantTx,
    config: StageApproverConfig,
    process: RequestingUnitsOf,
  ): Promise<StageApprover> {
    return this.stageApprovals.resolve(tx, config, process);
  }

  /**
   * RN-TRAM-43..53 (US-047 → US-051): abre a `Approval` `PENDING` da etapa com a cobertura,
   * `approval.request` e `ApprovalRequested`, no `tx` de quem encaminha (falha desfaz tudo).
   */
  requestForStageIn(tx: TenantTx, request: StageApprovalRequest): Promise<void> {
    return this.stageApprovals.request(tx, request);
  }

  /** Aprovações `PENDING` do processo (mais antigas primeiro), no `tx` do chamador. Leitura. */
  async listPendingForProcess(tx: TenantTx, processId: string): Promise<PendingApprovalFact[]> {
    const rows = await this.approvals.listPendingByProcess(tx, processId);
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      processStageId: row.processStageId,
      documentId: row.documentId,
      approverType: row.approverType,
      approverUserId: row.approverUserId,
      approverRoleId: row.approverRoleId,
      approverDepartmentId: row.approverDepartmentId,
      allowDeputy: row.allowDeputy,
      requestedAt: row.requestedAt,
      dueAt: row.dueAt,
    }));
  }
}
