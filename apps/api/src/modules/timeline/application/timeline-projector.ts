import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import { isRetryableTransactionError, isTransientDatabaseError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { SYNC_EVENT_HANDLERS } from '#shared/outbox/outbox-writer.js';
import type {
  RecordedDomainEvent,
  SyncEventHandler,
  SyncEventHandlerRegistryPort,
} from '#shared/outbox/outbox-writer.js';

import { TIMELINE_ENTRY_STORE } from './ports.js';
import type { TimelineEntryStore } from './ports.js';
import { TimelineLookupResolver } from './timeline-lookup.resolver.js';
import { timelineMetrics } from './timeline-telemetry.js';
import { TimelinePayloadError } from '../domain/timeline-entry.js';
import { lookupRef } from '../domain/timeline-lookups.js';
import { TIMELINE_MAPPINGS, TIMELINE_ROUTING_KEYS } from '../domain/timeline-mappings.js';

/** Nome do ator já conhecido pelo caso de uso, ou o usuário cujo nome precisa ser lido. */
interface ActorName {
  readonly name: string | null;
  readonly lookupUserId: string | null;
}

/**
 * `TimelineProjector` (US-059 · DEC-161 · RN-FND-52): handler síncrono in-process registrado no
 * `SYNC_EVENT_HANDLERS`. O `OutboxWriter` o chama logo depois do INSERT do evento, no mesmo `tx`
 * do caso de uso (RLS do tenant): resolve o `type` (RN-TML-02), congela os nomes (RN-TML-04),
 * calcula a visibilidade (POL-09) e grava `ProcessTimelineEntry` de forma idempotente (RN-TML-03).
 * Qualquer erro desfaz o caso de uso inteiro (RN-TML-01); evento sem mapeamento é ignorado
 * (RN-TML-07). Não abre transação própria nem escreve no outbox.
 */
@Injectable()
export class TimelineProjector implements SyncEventHandler, OnModuleInit {
  readonly name = 'TimelineProjector';
  readonly routingKeys = TIMELINE_ROUTING_KEYS;
  private readonly logger = new Logger('Timeline');

  constructor(
    @Inject(SYNC_EVENT_HANDLERS) private readonly registry: SyncEventHandlerRegistryPort,
    @Inject(TIMELINE_ENTRY_STORE) private readonly store: TimelineEntryStore,
    private readonly lookups: TimelineLookupResolver,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  handle(tx: TenantTx, event: RecordedDomainEvent): Promise<void> {
    return this.project(tx, event);
  }

  /**
   * Projeta o evento no `tx` informado. Também é o ponto de entrada do reprocessamento (backfill
   * — FA-04): a mesma entrada não é gravada duas vezes.
   */
  async project(tx: TenantTx, event: RecordedDomainEvent): Promise<void> {
    const mapping = TIMELINE_MAPPINGS.get(event.eventType);
    if (!mapping) {
      this.notMapped(event);
      return;
    }
    const startedAt = performance.now();
    try {
      const plan = mapping.plan(event);
      if (plan === null || (event.processId === null && mapping.processOptional)) {
        this.notMapped(event);
        return;
      }
      const { processId, tenantId } = event;
      if (processId === null || tenantId === null) {
        throw new TimelinePayloadError(event.eventType, [
          `${processId === null ? 'processId' : 'tenantId'}: required`,
        ]);
      }
      const actor = this.actorName(event);
      const lookups = await this.lookups.resolve(tx, [
        ...plan.refs,
        ...lookupRef('DEPARTMENT', plan.actorDepartmentId),
        ...lookupRef('USER', actor.lookupUserId),
      ]);
      const actorName = actor.name ?? lookups.get('USER', actor.lookupUserId)?.name ?? null;
      const actorDepartmentName = lookups.get('DEPARTMENT', plan.actorDepartmentId)?.name ?? null;

      for (const projection of plan.build({ lookups, actorName })) {
        const outcome = await this.store.insert(tx, {
          ...projection,
          id: newId(),
          tenantId,
          processId,
          occurredAt: new Date(event.occurredAt),
          actorType: event.actor.type,
          actorId: event.actor.type === 'SYSTEM' ? null : event.actor.userId,
          actorName,
          actorDepartmentName,
          sourceEventId: event.eventId,
        });
        this.recorded(outcome, projection.type, event, processId, startedAt);
      }
      timelineMetrics().duration.record(elapsedMs(startedAt), { event_type: event.eventType });
    } catch (error) {
      throw this.failed(error, event);
    }
  }

  /**
   * Nome congelado do ator (RN-TML-04): o do contexto do caso de uso quando é o mesmo ator do
   * evento (já carregado na autenticação — nenhuma consulta); senão o usuário é lido (replay).
   */
  private actorName(event: RecordedDomainEvent): ActorName {
    const actor = currentRequestContext()?.actor;
    const sameActor = actor?.type === event.actor.type && actor.userId === event.actor.userId;
    const known = sameActor ? (actor.name ?? null) : null;
    if (known !== null || event.actor.userId === null) return { name: known, lookupUserId: null };
    return { name: null, lookupUserId: event.actor.userId };
  }

  private recorded(
    outcome: 'inserted' | 'duplicate',
    type: string,
    event: RecordedDomainEvent,
    processId: string,
    startedAt: number,
  ): void {
    if (outcome === 'duplicate') {
      timelineMetrics().duplicates.add(1, { type });
      this.logger.warn(
        { event: 'timeline.duplicate_ignored', sourceEventId: event.eventId, type },
        'timeline.duplicate_ignored',
      );
      return;
    }
    timelineMetrics().projected.add(1, { type });
    this.logger.log(
      {
        event: 'timeline.entry_projected',
        processId,
        type,
        sourceEventId: event.eventId,
        durationMs: elapsedMs(startedAt),
      },
      'timeline.entry_projected',
    );
  }

  private notMapped(event: RecordedDomainEvent): void {
    this.logger.debug(
      { event: 'timeline.event_not_mapped', eventType: event.eventType },
      'timeline.event_not_mapped',
    );
  }

  /** Log e métrica da falha (sem payload nem `params` — podem ter dado sensível); propaga. */
  private failed(error: unknown, event: RecordedDomainEvent): unknown {
    // Deadlock/serialização: a TenantTransaction refaz a transação inteira, projeção inclusive.
    if (isRetryableTransactionError(error)) return error;
    const errorCode = isTransientDatabaseError(error) ? 'DEPENDENCY_UNAVAILABLE' : 'INTERNAL_ERROR';
    timelineMetrics().failed.add(1, { error_code: errorCode });
    this.logger.error(
      {
        event: 'timeline.projection_failed',
        eventType: event.eventType,
        sourceEventId: event.eventId,
        errorCode,
        cause: error instanceof Error ? error.name : 'unknown',
        correlationId: event.correlationId,
      },
      'timeline.projection_failed',
    );
    return error;
  }
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}
