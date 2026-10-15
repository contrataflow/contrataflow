import type { JobData, QueueName } from '@contrataflow/types';
import { Logger } from '@nestjs/common';

import type { WorkerDatabase } from '#shared/database/worker-database.js';

import type { QueueMetrics } from './queue-metrics.js';
import type { HandlerResult } from './run-job.js';

/*
 * Jobs agendados (RN-FND-68 · queues.md §12): BullMQ Job Schedulers (`upsertJobScheduler`,
 * idempotente no bootstrap de toda réplica — um job por iteração mesmo com N réplicas). Cada
 * execução segura uma trava consultiva própria: sem ela, conclui como `skipped` (FA-03). Sem
 * *catch-up* (FA-05): os handlers são baseados em estado, não em janela de tempo.
 */

export interface SchedulerDefinition {
  readonly id: string;
  readonly queue: Extract<QueueName, 'deadlines' | 'audit-seal' | 'maintenance'>;
  readonly pattern: string;
  readonly tz: string;
  readonly jobName: string;
  /** Idade máxima do último sucesso antes do alerta (queues.md §12 — vivacidade). */
  readonly slaSeconds: number;
}

export const SCHEDULERS: readonly SchedulerDefinition[] = [
  {
    id: 'deadlines-tick',
    queue: 'deadlines',
    pattern: '*/15 * * * *',
    tz: 'UTC',
    jobName: 'tick',
    slaSeconds: 45 * 60,
  },
  {
    id: 'audit-seal-tick',
    queue: 'audit-seal',
    pattern: '5 * * * *',
    tz: 'UTC',
    jobName: 'tick',
    slaSeconds: 3 * 3_600,
  },
  {
    id: 'maintenance-daily',
    queue: 'maintenance',
    pattern: '0 3 * * *',
    tz: 'America/Sao_Paulo',
    jobName: 'daily',
    slaSeconds: 26 * 3_600,
  },
];

/** Correlação fixa por scheduler: as execuções agendadas não têm requisição de origem. */
export function schedulerCorrelationId(id: string): string {
  return `scheduler:${id}`;
}

/** `JobData` de plataforma do job gerado pelo scheduler (`tenantId` nulo — queues.md §9.3). */
export function schedulerJobData(definition: SchedulerDefinition, now: Date): JobData<object> {
  return {
    meta: {
      schemaVersion: 1,
      tenantId: null,
      actor: { type: 'SYSTEM', userId: null, membershipId: null },
      correlationId: schedulerCorrelationId(definition.id),
      causationId: null,
      enqueuedAt: now.toISOString(),
    },
    payload: {},
  };
}

/** Parte da `Queue` do BullMQ usada pelos schedulers. */
export interface SchedulerQueuePort {
  upsertJobScheduler(
    id: string,
    repeat: { pattern: string; tz: string },
    template: { name: string; data: JobData<object> },
  ): Promise<unknown>;
  getJobSchedulers(): Promise<readonly { readonly key: string }[]>;
  removeJobScheduler(id: string): Promise<boolean>;
}

/**
 * Sincroniza os schedulers de cada fila agendada (V-04): `upsert` dos definidos e remoção de
 * qualquer outro id na fila (ex.: scheduler renomeado), para nunca haver dois padrões ativos.
 */
export async function syncSchedulers(
  queueOf: (queue: SchedulerDefinition['queue']) => SchedulerQueuePort,
  now: Date,
  definitions: readonly SchedulerDefinition[] = SCHEDULERS,
): Promise<void> {
  const ids = new Set(definitions.map((definition) => definition.id));
  if (ids.size !== definitions.length) throw new Error('Scheduler com id duplicado');
  for (const definition of definitions) {
    await queueOf(definition.queue).upsertJobScheduler(
      definition.id,
      { pattern: definition.pattern, tz: definition.tz },
      { name: definition.jobName, data: schedulerJobData(definition, now) },
    );
  }
  for (const queue of new Set(definitions.map((definition) => definition.queue))) {
    for (const scheduler of await queueOf(queue).getJobSchedulers()) {
      if (!ids.has(scheduler.key)) await queueOf(queue).removeJobScheduler(scheduler.key);
    }
  }
}

const logger = new Logger('Schedulers');

/**
 * Executa a iteração agendada sob a trava consultiva do scheduler: outra execução em andamento
 * (em qualquer réplica) faz esta concluir como `skipped` (`cf_scheduled_job_skipped_total`).
 */
export async function runScheduled(
  definition: SchedulerDefinition,
  database: Pick<WorkerDatabase, 'withAdvisoryLock'>,
  metrics: QueueMetrics,
  work: () => Promise<void>,
  now: () => Date = () => new Date(),
): Promise<HandlerResult> {
  const { acquired } = await database.withAdvisoryLock(`cf:scheduler:${definition.id}`, work);
  if (!acquired) {
    metrics.scheduledJobSkipped(definition.id);
    metrics.jobProcessed(definition.queue, definition.jobName, 'skipped', 0);
    logger.warn({
      event: 'worker.scheduler_skipped',
      scheduler: definition.id,
      reason: 'lock_held',
    });
    return 'skipped';
  }
  metrics.schedulerSucceeded(definition.id, now());
  return 'completed';
}

/** Último sucesso de cada scheduler, lido das execuções concluídas na fila (todas as réplicas). */
export interface SchedulerSuccessSource {
  lastSuccess(definition: SchedulerDefinition): Promise<Date | null>;
}

/**
 * Vivacidade dos schedulers (queues.md §12 · §15.3): publica o gauge do último sucesso e registra
 * `worker.scheduler_missed_sla` quando ele envelhece além do limite. Sem sucesso conhecido, conta
 * a partir da subida do processo (as execuções concluídas ficam 24 h na fila).
 */
export async function checkSchedulerSla(
  source: SchedulerSuccessSource,
  metrics: QueueMetrics,
  startedAt: Date,
  now: Date,
  definitions: readonly SchedulerDefinition[] = SCHEDULERS,
): Promise<readonly string[]> {
  const missed: string[] = [];
  for (const definition of definitions) {
    const last = await source.lastSuccess(definition);
    if (last) metrics.schedulerSucceeded(definition.id, last);
    const reference = last ?? startedAt;
    const ageSeconds = Math.floor((now.getTime() - reference.getTime()) / 1_000);
    if (ageSeconds > definition.slaSeconds) {
      missed.push(definition.id);
      logger.error({
        event: 'worker.scheduler_missed_sla',
        alert: true,
        scheduler: definition.id,
        lastSuccessAgeSeconds: ageSeconds,
      });
    }
  }
  return missed;
}
