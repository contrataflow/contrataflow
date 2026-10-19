import {
  ApprovalRequested,
  ProcessAssigned,
  ProcessCreated,
  ProcessStageChanged,
  ProcessUpdated,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import type { RecordedDomainEvent, SyncEventHandler } from '#shared/outbox/outbox-writer.js';

import { PROCESS_REPOSITORY } from './ports.js';
import type { ProcessRepository } from './ports.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import { creationGrants } from '../domain/process-runtime-records.js';
import { stageChangeAccess } from '../domain/stage-transition.js';

/** Atribuições sem mudança de etapa: assumir (US-049) e atribuir (US-050). */
const DIRECT_ASSIGNMENTS: ReadonlySet<string> = new Set(['CLAIM', 'MANUAL']);

/** Campos cuja alteração muda as concessões `REQUESTING` (RN-PROC-62). */
const REQUESTING_FIELDS = new Set(['requestingSecretariatId', 'requestingDepartmentId']);

/**
 * `ProcessAccessProjector` (DEC-024 · DEC-161 · permissions.md §5): handler síncrono que mantém as
 * concessões `ProcessAccess` no MESMO `tx` do fato — se falhar, o processo, o evento e a timeline
 * são desfeitos juntos. US-001: `process.created` → `REQUESTING` (secretaria e setor), `CURRENT`
 * (unidade da etapa inicial), `CREATOR` (ator do evento) e `RESPONSIBLE` (responsável inicial).
 * US-005: `process.updated` com a secretaria ou o setor solicitante alterado → revoga as concessões
 * `REQUESTING` anteriores e concede as novas (RN-PROC-62). US-047: `process.stage_changed.*` →
 * `CURRENT` da origem vira `HISTORICAL` (unidade mudou), `CURRENT` do destino e `RESPONSIBLE` do
 * novo responsável (RN-TRAM-17); `process.assigned` `CLAIM` (US-049) ou `MANUAL` (US-050) →
 * `RESPONSIBLE` do novo responsável; `approval.requested` (US-051) → `APPROVER` para o aprovador designado e, com
 * `allowDeputy`, o substituto da unidade (RN-TRAM-53 — o perfil `ROLE` decide pela unidade, que já
 * tem o `CURRENT`).
 */
@Injectable()
export class ProcessAccessProjector implements SyncEventHandler {
  readonly name = 'ProcessAccessProjector';
  readonly routingKeys = [
    'process.created',
    'process.updated',
    'process.stage_changed.*',
    'process.assigned',
    'approval.requested',
  ];

  constructor(
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    private readonly organization: OrganizationFacade,
  ) {}

  async handle(tx: TenantTx, event: RecordedDomainEvent): Promise<void> {
    const at = new Date(event.occurredAt);
    switch (event.eventType) {
      case ProcessUpdated.eventType: {
        const { changedFields } = ProcessUpdated.payloadSchema.parse(event.payload);
        if (changedFields.some((field) => REQUESTING_FIELDS.has(field))) {
          await this.processes.syncRequestingAccess(tx, event.aggregateId, at);
        }
        return;
      }
      case ProcessCreated.eventType: {
        const payload = ProcessCreated.payloadSchema.parse(event.payload);
        await this.processes.grantAccess(
          tx,
          event.aggregateId,
          creationGrants({
            requestingSecretariatId: payload.requestingSecretariatId,
            requestingDepartmentId: payload.requestingDepartmentId,
            currentDepartmentId: payload.initialDepartmentId,
            creatorId: event.actor.userId,
            responsibleId: payload.initialResponsibleId,
          }),
          at,
        );
        return;
      }
      case ProcessStageChanged.eventType: {
        const payload = ProcessStageChanged.payloadSchema.parse(event.payload);
        const access = stageChangeAccess(payload);
        if (access.historicalDepartmentId !== null) {
          await this.processes.retireCurrentAccess(
            tx,
            event.aggregateId,
            access.historicalDepartmentId,
            at,
          );
        }
        await this.processes.grantAccess(tx, event.aggregateId, access.grants, at);
        return;
      }
      case ProcessAssigned.eventType: {
        // US-049/US-050: assumir e atribuir não mudam de etapa — o novo responsável ganha o
        // `RESPONSIBLE`. A entrada em etapa e a devolução já concedem pelo `ProcessStageChanged`.
        const payload = ProcessAssigned.payloadSchema.parse(event.payload);
        if (!DIRECT_ASSIGNMENTS.has(payload.assignmentType) || payload.toUserId === null) return;
        await this.processes.grantAccess(
          tx,
          event.aggregateId,
          [{ principalType: 'USER', userId: payload.toUserId, reason: 'RESPONSIBLE' }],
          at,
        );
        return;
      }
      case ApprovalRequested.eventType: {
        const payload = ApprovalRequested.payloadSchema.parse(event.payload);
        if (event.processId === null) return;
        // RN-TRAM-53: o aprovador designado e, com `allowDeputy`, o substituto da unidade (lido no
        // mesmo `tx` — RLS do tenant). `ROLE` decide pela unidade, que já tem o `CURRENT`.
        const deputyUserId =
          payload.allowDeputy && payload.approverDepartmentId !== null
            ? ((await this.organization.findDepartmentForApproval(tx, payload.approverDepartmentId))
                ?.deputyUserId ?? null)
            : null;
        const userIds = [
          ...new Set([payload.approverUserId, deputyUserId].filter((id) => id !== null)),
        ];
        if (userIds.length === 0) return;
        await this.processes.grantAccess(
          tx,
          event.processId,
          userIds.map((userId) => ({
            principalType: 'USER' as const,
            userId,
            reason: 'APPROVER' as const,
            sourceId: payload.approvalId,
          })),
          at,
        );
        return;
      }
      default:
        return;
    }
  }
}
