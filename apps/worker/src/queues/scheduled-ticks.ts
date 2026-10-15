import type { QueueName } from '@contrataflow/types';
import { z } from 'zod';

import type { WorkerDatabase } from '#shared/database/worker-database.js';

import type { JobProducer } from './job-producer.js';
import type { QueueMetrics } from './queue-metrics.js';
import type { HandlerResult, JobHandler, JobHandlerContext } from './run-job.js';
import { SCHEDULERS, runScheduled } from './schedulers.js';
import type { SchedulerDefinition } from './schedulers.js';

/*
 * Jobs de plataforma gerados pelos schedulers (queues.md §4.6–§4.8 · §12): sob a trava do
 * scheduler, listam os tenants elegíveis (tabela de plataforma `tenants`) e enfileiram UM job por
 * tenant, com `jobId` determinístico por iteração — reexecutar a iteração não duplica trabalho.
 * Os handlers por tenant (`DeadlineScanner`, `AuditSealer`, housekeeping…) são registrados pelas
 * stories donas; enquanto um filho não tem handler, ele não é enfileirado (nada para na fila sem
 * consumidor nem vai para a dead-letter por falta de handler).
 */

const emptyPayload = z.strictObject({});

export interface TickDeps {
  readonly producer: JobProducer;
  readonly database: Pick<WorkerDatabase, 'withAdvisoryLock'>;
  readonly metrics: QueueMetrics;
  /** O par fila/job tem handler registrado neste worker. */
  readonly isHandled: (queue: QueueName, jobName: string) => boolean;
  readonly now?: () => Date;
}

async function tenantsWithStatus(
  context: JobHandlerContext,
  statuses: readonly string[],
): Promise<string[]> {
  const { rows } = await context.platformTransaction((client) =>
    client.query<{ id: string }>(
      'SELECT id FROM tenants WHERE status::text = ANY($1::text[]) ORDER BY id',
      [statuses],
    ),
  );
  return rows.map((row) => row.id);
}

const QUARTER_HOUR_MS = 15 * 60_000;
const HOUR_MS = 3_600_000;

/** Início do intervalo (epoch, s) que contém `at`. */
function slotOf(at: Date, sizeMs: number): number {
  return Math.floor(at.getTime() / sizeMs) * (sizeMs / 1_000);
}

function definitionOf(id: string): SchedulerDefinition {
  const definition = SCHEDULERS.find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`Scheduler ${id} não definido`);
  return definition;
}

abstract class ScheduledTick implements JobHandler<Record<string, never>> {
  readonly payloadSchema = emptyPayload;
  abstract readonly queue: SchedulerDefinition['queue'];
  abstract readonly name: string;
  protected abstract readonly scheduler: SchedulerDefinition;

  constructor(protected readonly deps: TickDeps) {}

  protected now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  protected async enqueueIfHandled(
    queue: QueueName,
    name: string,
    jobId: string,
    tenantId?: string,
  ): Promise<void> {
    if (!this.deps.isHandled(queue, name)) return;
    await this.deps.producer.enqueue(
      queue,
      name,
      {},
      {
        jobId,
        ...(tenantId === undefined ? {} : { tenantId }),
      },
    );
  }

  protected abstract fanOut(context: JobHandlerContext): Promise<void>;

  handle(_payload: Record<string, never>, context: JobHandlerContext): Promise<HandlerResult> {
    return runScheduled(
      this.scheduler,
      this.deps.database,
      this.deps.metrics,
      () => this.fanOut(context),
      () => this.now(),
    );
  }
}

/** `deadlines.tick` → `scan-tenant` por tenant `ACTIVE` (`jobId = deadlines.{tenantId}.{slot}`). */
export class DeadlinesTick extends ScheduledTick {
  readonly queue = 'deadlines' as const;
  readonly name = 'tick';
  protected readonly scheduler = definitionOf('deadlines-tick');

  protected async fanOut(context: JobHandlerContext): Promise<void> {
    if (!this.deps.isHandled('deadlines', 'scan-tenant')) return;
    const slot = slotOf(this.now(), QUARTER_HOUR_MS);
    for (const tenantId of await tenantsWithStatus(context, ['ACTIVE'])) {
      await this.enqueueIfHandled(
        'deadlines',
        'scan-tenant',
        `deadlines.${tenantId}.${String(slot)}`,
        tenantId,
      );
    }
  }
}

/** `audit-seal.tick` → `seal-tenant` por tenant `ACTIVE` + `seal-platform`. */
export class AuditSealTick extends ScheduledTick {
  readonly queue = 'audit-seal' as const;
  readonly name = 'tick';
  protected readonly scheduler = definitionOf('audit-seal-tick');

  protected async fanOut(context: JobHandlerContext): Promise<void> {
    const period = slotOf(this.now(), HOUR_MS);
    if (this.deps.isHandled('audit-seal', 'seal-tenant')) {
      for (const tenantId of await tenantsWithStatus(context, ['ACTIVE'])) {
        await this.enqueueIfHandled(
          'audit-seal',
          'seal-tenant',
          `audit-seal.${tenantId}.${String(period)}`,
          tenantId,
        );
      }
    }
    await this.enqueueIfHandled(
      'audit-seal',
      'seal-platform',
      `audit-seal.platform.${String(period)}`,
    );
  }
}

/** Jobs de plataforma da manutenção diária (queues.md §4.8). */
export const MAINTENANCE_PLATFORM_JOBS = [
  'outbox-purge',
  'processed-events-purge',
  'audit-partitions-ensure',
] as const;

/** `maintenance.daily` → jobs de plataforma + `tenant-housekeeping` por tenant ativo/suspenso. */
export class MaintenanceDaily extends ScheduledTick {
  readonly queue = 'maintenance' as const;
  readonly name = 'daily';
  protected readonly scheduler = definitionOf('maintenance-daily');

  protected async fanOut(context: JobHandlerContext): Promise<void> {
    const day = this.now().toISOString().slice(0, 10);
    for (const job of MAINTENANCE_PLATFORM_JOBS) {
      await this.enqueueIfHandled('maintenance', job, `maintenance.${job}.${day}`);
    }
    if (!this.deps.isHandled('maintenance', 'tenant-housekeeping')) return;
    for (const tenantId of await tenantsWithStatus(context, ['ACTIVE', 'SUSPENDED'])) {
      await this.enqueueIfHandled(
        'maintenance',
        'tenant-housekeeping',
        `maintenance.tenant-housekeeping.${tenantId}.${day}`,
        tenantId,
      );
    }
  }
}
