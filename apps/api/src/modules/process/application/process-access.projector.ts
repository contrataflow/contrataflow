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
import { creationGrants } from '../domain/process-runtime-records.js';
import { stageChangeAccess } from '../domain/stage-transition.js';

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
 * novo responsável (RN-TRAM-17); `process.assigned` `CLAIM` (US-049) → `RESPONSIBLE` de quem assumiu; `approval.requested` → `APPROVER` para o aprovador designado
 * (RN-TRAM-53 — o perfil `ROLE` decide pela unidade, que já tem o `CURRENT`).
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

  constructor(@Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository) {}

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
        // US-049: o "assumir" não muda de etapa — o novo responsável ganha o `RESPONSIBLE`. A
        // entrada em etapa e a devolução já concedem pelo `ProcessStageChanged`.
        const payload = ProcessAssigned.payloadSchema.parse(event.payload);
        if (payload.assignmentType !== 'CLAIM' || payload.toUserId === null) return;
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
        if (event.processId === null || payload.approverUserId === null) return;
        await this.processes.grantAccess(
          tx,
          event.processId,
          [
            {
              principalType: 'USER',
              userId: payload.approverUserId,
              reason: 'APPROVER',
              sourceId: payload.approvalId,
            },
          ],
          at,
        );
        return;
      }
      default:
        return;
    }
  }
}
