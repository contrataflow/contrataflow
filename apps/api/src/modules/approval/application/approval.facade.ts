import type { ApproverType } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { ApprovalRequestService } from './approval-request.service.js';
import type { StageApprovalRequest } from './approval-request.service.js';
import { ApproverResolver } from './approver-resolver.js';
import type { StageApprover } from './approver-resolver.js';
import { APPROVAL_REPOSITORY } from './ports.js';
import type { ApprovalRepository } from './ports.js';
import type { RequestingUnitsOf, StageApproverConfig } from '../domain/approval.js';

export type { StageApprovalRequest, StageCoverage } from './approval-request.service.js';
export type { StageApprover } from './approver-resolver.js';
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
 * US-047/US-051: a aprovação de etapa aberta pelo encaminhamento (a avulsa do DOC-09 entra pela
 * porta `DocumentApprovalRegistry`).
 */
@Injectable()
export class ApprovalFacade {
  constructor(
    @Inject(APPROVAL_REPOSITORY) private readonly approvals: ApprovalRepository,
    private readonly resolver: ApproverResolver,
    private readonly requests: ApprovalRequestService,
  ) {}

  /**
   * Prévia do aprovador da etapa `APPROVAL` (US-047 · PRC-08 `approverPreview`): resolvido como na
   * solicitação, com o rótulo; `null` = não resolvível (`APPROVER_UNRESOLVED` no encaminhamento).
   */
  previewStageApproverIn(
    tx: TenantTx,
    config: StageApproverConfig,
    process: RequestingUnitsOf,
    now: Date,
  ): Promise<StageApprover | null> {
    return this.resolver.preview(tx, config, process, now);
  }

  /**
   * RN-TRAM-47..49: o aprovador da etapa `APPROVAL` resolvido NA solicitação, no `tx` do
   * encaminhamento. @throws ApiError 422 `APPROVER_UNRESOLVED`
   */
  resolveStageApproverIn(
    tx: TenantTx,
    config: StageApproverConfig,
    process: RequestingUnitsOf,
    now: Date,
  ): Promise<StageApprover> {
    return this.resolver.resolve(tx, config, process, now, 'PROCESS_STAGE');
  }

  /**
   * RN-TRAM-43..53 (US-051 · disparo A): abre a `Approval` `PENDING` da etapa com a cobertura,
   * `approval.request` e `ApprovalRequested`, no `tx` de quem encaminha (falha desfaz tudo).
   * @throws ApiError 409 `APPROVAL_NOT_PENDING`
   */
  requestForStageIn(tx: TenantTx, request: StageApprovalRequest): Promise<void> {
    return this.requests.requestForStageEntry(tx, request);
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
