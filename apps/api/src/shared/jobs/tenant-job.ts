import {
  CORRELATION_ID_PATTERN,
  captureJobTraceMeta,
  runInJobContext,
} from '@contrataflow/observability';
import { Logger } from '@nestjs/common';
import { z } from 'zod';

import type { TenantStatusPort } from '../auth/ports.js';
import { currentRequestContext, runInJobRequestContext } from '../context/request-context.js';
import { tenantContextMissing } from '../tenancy/isolation.js';

/*
 * Contexto de tenant em jobs (US-100 · FA-03 · RN-TEN-31 · DEC-164 · queues.md §3/§9): o produtor
 * grava o `JobMeta` a partir do contexto (nunca à mão); o consumidor valida o `meta`, restaura o
 * contexto — tenant, ator, correlação e trace — e só então chama o handler, que acessa o banco pela
 * `TenantTransaction` (RLS do tenant do job, como na API). A fila BullMQ, o `JobProducer` e o
 * `runJob` completo (timeouts, DLQ, métricas) são da US-083; o worker importa esta base de
 * `apps/api/src/shared` (architecture.md §4.3).
 */

/** Ator do job: quem originou o trabalho (`meta.actor` — queues.md §3). */
const jobActorSchema = z.strictObject({
  type: z.enum(['USER', 'SYSTEM', 'PLATFORM_OPERATOR', 'INTEGRATION']),
  userId: z.uuid().nullable(),
  membershipId: z.uuid().nullable(),
});

/** `JobMeta` (queues.md §3 · DEC-164): validado antes de qualquer efeito. */
export const jobMetaSchema = z.strictObject({
  schemaVersion: z.literal(1),
  tenantId: z.uuid().nullable(),
  actor: jobActorSchema,
  correlationId: z.string().regex(CORRELATION_ID_PATTERN),
  causationId: z.uuid().nullable(),
  traceparent: z.string().max(55).optional(),
  tracestate: z.string().max(512).optional(),
  enqueuedAt: z.iso.datetime(),
});

export type JobMeta = z.infer<typeof jobMetaSchema>;

/**
 * Pares fila/job que aceitam `tenantId` nulo (queues.md §9.3 — lista fechada). Jobs de plataforma
 * que percorrem tenants enumeram os `ACTIVE` pelo `SystemDbService` e enfileiram um job POR tenant.
 */
export const PLATFORM_JOBS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  deadlines: ['tick'],
  'audit-seal': ['tick', 'seal-platform'],
  maintenance: [
    'daily',
    'reconcile',
    'outbox-purge',
    'processed-events-purge',
    'audit-partitions-ensure',
  ],
});

export function isPlatformJob(queue: string, jobName: string): boolean {
  return PLATFORM_JOBS[queue]?.includes(jobName) ?? false;
}

/**
 * Confere a regra de tenant do par fila/job (V-09): job sem `tenantId` fora da lista de plataforma
 * é rejeitado — na origem (produtor) e no consumo — com `error security.tenant_context_missing`.
 */
export function assertJobTenancy(queue: string, jobName: string, tenantId: string | null): void {
  if (tenantId === null && !isPlatformJob(queue, jobName)) {
    throw tenantContextMissing('job', { queue, jobName });
  }
}

/**
 * Lado produtor: `JobMeta` do contexto atual (requisição ou job), com o `traceparent` do span
 * `<fila> publish`. Job de tenant sem tenant no contexto → erro na origem (RN-TEN-31).
 */
export async function buildJobMeta(
  queue: string,
  jobName: string,
  options: { readonly causationId?: string | null } = {},
): Promise<JobMeta> {
  const context = currentRequestContext();
  const tenantId = context?.tenantId ?? null;
  assertJobTenancy(queue, jobName, tenantId);
  const trace = await captureJobTraceMeta(queue, {
    correlationId: context?.correlationId ?? '',
    tenantId,
  });
  const actorType = context?.actor.type ?? 'SYSTEM';
  return jobMetaSchema.parse({
    schemaVersion: 1,
    tenantId,
    actor: {
      type: actorType === 'ANONYMOUS' ? 'SYSTEM' : actorType,
      userId: context?.actor.userId ?? null,
      membershipId: context?.actor.membershipId ?? null,
    },
    correlationId: context?.correlationId,
    causationId: options.causationId ?? null,
    ...(trace.traceparent ? { traceparent: trace.traceparent } : {}),
    ...(trace.tracestate ? { tracestate: trace.tracestate } : {}),
    enqueuedAt: new Date().toISOString(),
  });
}

/** Execução de um job entregue pela fila (o `Job` do BullMQ reduzido ao necessário). */
export interface TenantJobRun {
  readonly id: string;
  readonly queue: string;
  readonly name: string;
  /** Tentativa atual, começando em 1. */
  readonly attempt: number;
  readonly data: { readonly meta: unknown; readonly payload: unknown };
}

/** `meta` ou `payload` inválido: erro permanente (vira `UnrecoverableError` no `runJob`). */
export class InvalidJobDataError extends Error {
  constructor(readonly part: 'meta' | 'payload') {
    super(`Dados do job inválidos (${part}).`);
    this.name = 'InvalidJobDataError';
  }
}

export type TenantJobOutcome = 'completed' | 'skipped_tenant_inactive';

/**
 * Base de todo handler de job (US-100 · FA-03): valida `meta` e `payload`, aplica a regra de tenant
 * (§9.3), conclui sem efeito quando o tenant não está `ACTIVE` (RN-TEN-12), restaura o contexto de
 * tenant e de trace e só então executa `handle`. Dentro dele, `TenantTransaction` usa o tenant do
 * job e os logs carregam `tenantId`, `correlationId`, fila e tentativa.
 */
export abstract class TenantJob<P> {
  protected readonly logger = new Logger(this.constructor.name);

  protected abstract readonly payloadSchema: z.ZodType<P>;

  constructor(private readonly tenants: TenantStatusPort) {}

  protected abstract handle(payload: P, meta: JobMeta): Promise<void>;

  async process(job: TenantJobRun): Promise<TenantJobOutcome> {
    const meta = jobMetaSchema.safeParse(job.data.meta);
    if (!meta.success) throw new InvalidJobDataError('meta');
    assertJobTenancy(job.queue, job.name, meta.data.tenantId);
    const payload = this.payloadSchema.safeParse(job.data.payload);
    if (!payload.success) throw new InvalidJobDataError('payload');

    const { tenantId } = meta.data;
    if (tenantId !== null && (await this.tenants.findStatus(tenantId)) !== 'ACTIVE') {
      this.logger.log(
        {
          event: 'job.skipped_tenant_inactive',
          queue: job.queue,
          jobName: job.name,
          jobId: job.id,
          tenantId,
          correlationId: meta.data.correlationId,
        },
        'job.skipped_tenant_inactive',
      );
      return 'skipped_tenant_inactive';
    }

    await runInJobContext(
      { queue: job.queue, jobName: job.name, jobId: job.id, attempt: job.attempt },
      {
        correlationId: meta.data.correlationId,
        tenantId,
        causationId: meta.data.causationId,
        ...(meta.data.traceparent ? { traceparent: meta.data.traceparent } : {}),
        ...(meta.data.tracestate ? { tracestate: meta.data.tracestate } : {}),
      },
      () =>
        runInJobRequestContext(
          {
            correlationId: meta.data.correlationId,
            tenantId,
            actor: meta.data.actor,
            jobName: `${job.queue}:${job.name}`,
          },
          () => this.handle(payload.data, meta.data),
        ),
    );
    return 'completed';
  }
}
