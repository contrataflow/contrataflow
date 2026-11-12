import { approvalProgressOf } from '@contrataflow/validation';
import type { ApprovalProgressDto, TaskInboxItemDto } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { ApprovalFacade } from '../../approval/application/approval.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import { ProcessFacade } from '../../process/application/process.facade.js';
import { WorkflowFacade } from '../../workflow/application/workflow.facade.js';
import { canClaim, dueAtOf } from '../domain/task-inbox.js';
import type { InboxItemRow, InboxViewer } from '../domain/task-inbox.js';

/**
 * Linhas da caixa de tarefas (US-056 · TSK-01): nomes por lote pelas fachadas donas (etapa —
 * `workflow`; unidade — `organization`; responsável e solicitante — `identity`), o DTO `deadline`
 * do `process` (`DueDateBadge` — US-055) e a ação "Assumir" (RN-INBOX-11). Nenhum valor monetário
 * sai daqui (FA-05).
 */
@Injectable()
export class TaskInboxPresenter {
  constructor(
    private readonly workflow: WorkflowFacade,
    private readonly organization: OrganizationFacade,
    private readonly identity: IdentityFacade,
    private readonly processes: ProcessFacade,
    private readonly approvals: ApprovalFacade,
  ) {}

  /**
   * US-136 (RN-APV-70): o andamento de cada linha de aprovação. A linha da caixa está `PENDING`;
   * em `SEQUENTIAL` ela é a corrente, e o rótulo vem do `approval` (o mesmo do APV-02).
   */
  private async progressOf(
    tx: TenantTx,
    rows: readonly InboxItemRow[],
  ): Promise<Map<string, ApprovalProgressDto>> {
    const sequential = rows.flatMap((row) =>
      row.approval?.decisionPolicy === 'SEQUENTIAL' ? [row.approval] : [],
    );
    const labels = await this.approvals.lineLabelsIn(tx, sequential);
    const labelOf = new Map(sequential.map((line, index) => [line.id, labels[index] ?? '']));
    const progress = new Map<string, ApprovalProgressDto>();
    for (const { approval } of rows) {
      if (approval === null) continue;
      progress.set(
        approval.id,
        approvalProgressOf({
          policy: approval.decisionPolicy,
          approvalStatus: 'PENDING',
          counts: approval.lineCounts,
          current:
            approval.decisionPolicy === 'SEQUENTIAL'
              ? { sequence: approval.sequence, label: labelOf.get(approval.id) ?? '' }
              : null,
        }),
      );
    }
    return progress;
  }

  async present(
    tx: TenantTx,
    rows: readonly InboxItemRow[],
    viewer: InboxViewer,
  ): Promise<TaskInboxItemDto[]> {
    if (rows.length === 0) return [];
    const stages = new Map((await this.workflow.releasedStages(tx)).map((s) => [s.id, s]));
    const departmentNames = await this.organization.departmentNames(tx, [
      ...new Set(rows.map((row) => row.process.currentDepartmentId)),
    ]);
    const userNames = await this.identity.userDisplayNames(tx, [
      ...new Set(
        rows.flatMap((row) => [
          ...(row.process.currentResponsibleId === null ? [] : [row.process.currentResponsibleId]),
          ...(row.approval === null ? [] : [row.approval.requestedById]),
        ]),
      ),
    ]);
    const deadlines = await this.processes.stageDeadlinesIn(
      tx,
      rows.map((row) => ({
        dueAt: dueAtOf(row),
        slaType: row.process.slaType,
        pausedAt: row.process.pausedAt,
        overdueSince: row.process.overdueSince,
      })),
    );
    const progress = await this.progressOf(tx, rows);
    const userRef = (id: string) => ({ id, name: userNames.get(id) ?? id });
    return rows.flatMap((row, index) => {
      const deadline = deadlines[index];
      if (deadline === undefined) return [];
      const { process, approval } = row;
      const stage =
        process.currentWorkflowStageId === null
          ? undefined
          : stages.get(process.currentWorkflowStageId);
      const dueAt = dueAtOf(row);
      const item: TaskInboxItemDto = {
        id: row.key,
        processId: process.id,
        code: process.code,
        title: process.title,
        status: process.status,
        version: process.version,
        currentStage: stage ? { key: stage.key, name: stage.name } : null,
        currentDepartment: {
          id: process.currentDepartmentId,
          name: departmentNames.get(process.currentDepartmentId) ?? process.currentDepartmentId,
        },
        currentResponsible:
          process.currentResponsibleId === null ? null : userRef(process.currentResponsibleId),
        enteredAt: process.enteredAt?.toISOString() ?? null,
        dueAt: dueAt?.toISOString() ?? null,
        isOverdue: process.overdueSince !== null,
        overdueSince: process.overdueSince?.toISOString() ?? null,
        deadline,
        isBudgetConfidential: process.isBudgetConfidential,
        canClaim: canClaim(process, viewer),
        ...(approval === null
          ? {}
          : {
              approval: {
                id: approval.approvalId,
                approvalApproverId: approval.id,
                sequence: approval.sequence,
                decisionPolicy: approval.decisionPolicy,
                ...withProgress(progress.get(approval.id)),
                title: approval.title,
                subjectType: approval.subjectType,
                requestedBy: userRef(approval.requestedById),
                requestedAt: approval.requestedAt.toISOString(),
                // RN-APV-63: o prazo da linha, quando houver; senão o da aprovação.
                dueAt: (approval.lineDueAt ?? approval.dueAt)?.toISOString() ?? null,
              },
            }),
      };
      return [item];
    });
  }
}

const withProgress = (progress: ApprovalProgressDto | undefined) =>
  progress === undefined ? {} : { progress };
