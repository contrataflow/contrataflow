import { ProcessCreated } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import type { RecordedDomainEvent, SyncEventHandler } from '#shared/outbox/outbox-writer.js';

import { PROCESS_REPOSITORY } from './ports.js';
import type { ProcessRepository } from './ports.js';
import { creationGrants } from '../domain/process-runtime-records.js';

/**
 * `ProcessAccessProjector` (DEC-024 · DEC-161 · permissions.md §5): handler síncrono que mantém as
 * concessões `ProcessAccess` no MESMO `tx` do fato — se falhar, o processo, o evento e a timeline
 * são desfeitos juntos. US-001: `process.created` → `REQUESTING` (secretaria e setor), `CURRENT`
 * (unidade da etapa inicial), `CREATOR` (ator do evento) e `RESPONSIBLE` (responsável inicial). A
 * US-047 acrescenta as tramitações (`CURRENT` → `HISTORICAL`).
 */
@Injectable()
export class ProcessAccessProjector implements SyncEventHandler {
  readonly name = 'ProcessAccessProjector';
  readonly routingKeys = ['process.created'];

  constructor(@Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository) {}

  async handle(tx: TenantTx, event: RecordedDomainEvent): Promise<void> {
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
