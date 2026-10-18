import type { ActionEntry } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { PROCESS_CLOCK } from './ports.js';
import type { ProcessClock } from './ports.js';
import { ApprovalFacade } from '../../approval/application/approval.facade.js';
import { BusinessCalendarFacade } from '../../catalog/application/business-calendar.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import { WorkflowFacade } from '../../workflow/application/workflow.facade.js';
import type { ProcessRuntime } from '../domain/process-runtime.js';

/** "Casos de erro" (FA-12 · US-051 V-02): sem aprovador, o encaminhamento à etapa é recusado. */
const APPROVER_UNRESOLVED_MESSAGE =
  'Não há aprovador configurado para esta etapa. Fale com o administrador do órgão.';

/**
 * Prévias das entradas `FORWARD` de PRC-08 (US-047 · api/02-processes.md — "a prévia de cada
 * transição"): o nome da unidade de destino resolvida, o prazo previsto (`dueAtPreview` — SLA da
 * etapa destino a partir de agora, RN-TRAM-09) e o aprovador previsto (`approverPreview` — o
 * MESMO cálculo da solicitação; não resolvível = `null` e o motivo `APPROVER_UNRESOLVED`). Leitura
 * no `tx` da consulta; o encaminhamento confere tudo de novo sob a trava.
 */
@Injectable()
export class ForwardPreviews {
  constructor(
    @Inject(PROCESS_CLOCK) private readonly clock: ProcessClock,
    private readonly workflow: WorkflowFacade,
    private readonly calendar: BusinessCalendarFacade,
    private readonly organization: OrganizationFacade,
    private readonly approvals: ApprovalFacade,
  ) {}

  async enrich(
    tx: TenantTx,
    runtime: ProcessRuntime,
    actions: readonly ActionEntry[],
  ): Promise<ActionEntry[]> {
    if (!actions.some((entry) => entry.action === 'FORWARD')) return [...actions];
    const definition = await this.workflow.publishedDefinition(runtime.workflowVersionId);
    if (definition === null) return [...actions];
    const now = this.clock();
    const departmentIds = actions.flatMap((entry) =>
      entry.action === 'FORWARD' && entry.departmentResolution?.departmentId !== undefined
        ? [entry.departmentResolution.departmentId]
        : [],
    );
    const names = await this.organization.departmentNames(tx, departmentIds);
    const enriched: ActionEntry[] = [];
    for (const entry of actions) {
      const transition =
        entry.action === 'FORWARD'
          ? definition.transitions.find((candidate) => candidate.id === entry.transitionId)
          : undefined;
      const toStage =
        transition === undefined
          ? undefined
          : definition.stages.find((stage) => stage.id === transition.toStageId);
      if (toStage === undefined) {
        enriched.push(entry);
        continue;
      }
      const dueAtPreview =
        toStage.slaDays === null
          ? null
          : (
              await this.calendar.addBusinessDays(tx, now, toStage.slaDays, toStage.slaType)
            ).toISOString();
      const resolution = entry.departmentResolution;
      const departmentName =
        resolution?.departmentId === undefined ? undefined : names.get(resolution.departmentId);
      const next: ActionEntry = {
        ...entry,
        ...(resolution === undefined || departmentName === undefined
          ? {}
          : { departmentResolution: { ...resolution, departmentName } }),
        dueAtPreview,
        approverPreview: null,
      };
      if (toStage.type !== 'APPROVAL') {
        enriched.push(next);
        continue;
      }
      const approver = await this.approvals.previewStageApproverIn(
        tx,
        toStage,
        runtime.ruleProcess,
        now,
      );
      if (approver === null) {
        const reasons = [
          ...entry.reasons,
          { code: 'APPROVER_UNRESOLVED', message: APPROVER_UNRESOLVED_MESSAGE },
        ];
        enriched.push({ ...next, enabled: false, reasons });
        continue;
      }
      enriched.push({
        ...next,
        approverPreview: {
          type: approver.approverType,
          label: approver.label,
          ...(approver.approverUserId === null ? {} : { userId: approver.approverUserId }),
          ...(approver.approverRoleId === null ? {} : { roleId: approver.approverRoleId }),
          ...(approver.approverDepartmentId === null
            ? {}
            : { departmentId: approver.approverDepartmentId }),
        },
      });
    }
    return enriched;
  }
}
