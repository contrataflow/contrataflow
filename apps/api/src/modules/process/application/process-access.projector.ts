import { ProcessCreated, ProcessUpdated } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import type { RecordedDomainEvent, SyncEventHandler } from '#shared/outbox/outbox-writer.js';

import { PROCESS_REPOSITORY } from './ports.js';
import type { ProcessRepository } from './ports.js';
import { creationGrants } from '../domain/process-runtime-records.js';

/** Campos cuja alteração muda as concessões `REQUESTING` (RN-PROC-62). */
const REQUESTING_FIELDS = new Set(['requestingSecretariatId', 'requestingDepartmentId']);

/**
 * `ProcessAccessProjector` (DEC-024 · DEC-161 · permissions.md §5): handler síncrono que mantém as
 * concessões `ProcessAccess` no MESMO `tx` do fato — se falhar, o processo, o evento e a timeline
 * são desfeitos juntos. US-001: `process.created` → `REQUESTING` (secretaria e setor), `CURRENT`
 * (unidade da etapa inicial), `CREATOR` (ator do evento) e `RESPONSIBLE` (responsável inicial).
 * US-005: `process.updated` com a secretaria ou o setor solicitante alterado → revoga as concessões
 * `REQUESTING` anteriores e concede as novas (RN-PROC-62). A US-047 acrescenta as tramitações
 * (`CURRENT` → `HISTORICAL`).
 */
@Injectable()
export class ProcessAccessProjector implements SyncEventHandler {
  readonly name = 'ProcessAccessProjector';
  readonly routingKeys = ['process.created', 'process.updated'];

  constructor(@Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository) {}

  async handle(tx: TenantTx, event: RecordedDomainEvent): Promise<void> {
    if (event.eventType === ProcessUpdated.eventType) {
      const { changedFields } = ProcessUpdated.payloadSchema.parse(event.payload);
      if (changedFields.some((field) => REQUESTING_FIELDS.has(field))) {
        await this.processes.syncRequestingAccess(
          tx,
          event.aggregateId,
          new Date(event.occurredAt),
        );
      }
      return;
    }
    if (event.eventType !== ProcessCreated.eventType) return;
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
      new Date(event.occurredAt),
    );
  }
}
