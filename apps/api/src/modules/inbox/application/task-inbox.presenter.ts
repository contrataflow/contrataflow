import type { TaskInboxItemDto } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

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
  ) {}

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
                id: approval.id,
                title: approval.title,
                subjectType: approval.subjectType,
                requestedBy: userRef(approval.requestedById),
                requestedAt: approval.requestedAt.toISOString(),
                dueAt: approval.dueAt?.toISOString() ?? null,
              },
            }),
      };
      return [item];
    });
  }
}
