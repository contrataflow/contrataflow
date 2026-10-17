import type { ApproverType } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { APPROVAL_REPOSITORY } from './ports.js';
import type { ApprovalRepository } from './ports.js';

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
  constructor(@Inject(APPROVAL_REPOSITORY) private readonly approvals: ApprovalRepository) {}

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
