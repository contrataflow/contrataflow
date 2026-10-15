import { captureJobTraceMeta, uuidv7 } from '@contrataflow/observability';
import { isPlatformJob, isRegisteredJob } from '@contrataflow/types';
import type { JobData, JobMeta, QueueName } from '@contrataflow/types';
import type { JobsOptions } from 'bullmq';

import { currentJob } from './job-context.js';
import { PermanentJobError, SecurityJobError } from './job-errors.js';
import { DEFAULT_JOB_OPTIONS } from './queue-options.js';

/*
 * Produção de jobs no worker (RN-FND-63/65 · DEC-164 · queues.md §3/§9.1): `enqueue` monta o
 * `meta` a partir do job em execução (tenant, ator, correlação, causa) e injeta o `traceparent` do
 * span `<fila> publish` — o chamador passa só o payload. Recusa na origem: nome fora do registro
 * (V-03), payload acima de 16 KB (V-02) e job de tenant sem tenant (RN-FND-64).
 */

/** Teto do payload (RN-FND-65): somente IDs e metadados. */
export const MAX_PAYLOAD_BYTES = 16 * 1024;

/** Enfileiramento cru (BullMQ em produção; em memória nos testes). */
export interface QueueAddPort {
  add(queue: QueueName, name: string, data: JobData<unknown>, opts: JobsOptions): Promise<void>;
}

export interface EnqueueOptions extends JobsOptions {
  /**
   * Tenant do job filho — só aceito quando o job em execução é de plataforma e percorre os
   * tenants (ex.: `deadlines.tick` → `scan-tenant` por tenant — queues.md §4.6).
   */
  readonly tenantId?: string;
  /** `eventId` que originou o job (padrão: a causa do job em execução). */
  readonly causationId?: string | null;
}

export class JobProducer {
  constructor(
    private readonly queues: QueueAddPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async enqueue(
    queue: QueueName,
    name: string,
    payload: unknown,
    options: EnqueueOptions = {},
  ): Promise<void> {
    if (!isRegisteredJob(queue, name)) {
      throw new PermanentJobError('JOB_NOT_REGISTERED', `Job ${queue}/${name} fora do registro`);
    }
    const size = Buffer.byteLength(JSON.stringify(payload ?? null), 'utf8');
    if (size > MAX_PAYLOAD_BYTES) {
      throw new PermanentJobError(
        'JOB_PAYLOAD_TOO_LARGE',
        `Payload de ${queue}/${name} com ${String(size)} bytes (máximo ${String(MAX_PAYLOAD_BYTES)})`,
      );
    }
    const { tenantId: tenantOverride, causationId, ...jobOptions } = options;
    const meta = await this.metaFor(queue, name, tenantOverride, causationId);
    await this.queues.add(
      queue,
      name,
      { meta, payload },
      { ...DEFAULT_JOB_OPTIONS, ...jobOptions },
    );
  }

  private async metaFor(
    queue: QueueName,
    name: string,
    tenantOverride: string | undefined,
    causationId: string | null | undefined,
  ): Promise<JobMeta> {
    const active = currentJob();
    if (tenantOverride !== undefined && active !== undefined && active.meta.tenantId !== null) {
      // Só um job de plataforma escolhe o tenant do filho; um job de tenant herda o próprio.
      throw new SecurityJobError('TENANT_OVERRIDE_FORBIDDEN', 'Job de tenant não troca de tenant');
    }
    const tenantId = tenantOverride ?? active?.meta.tenantId ?? null;
    if (tenantId === null && !isPlatformJob(queue, name)) {
      throw new SecurityJobError('TENANT_CONTEXT_REQUIRED', `Job ${queue}/${name} exige tenant`);
    }
    const correlationId = active?.meta.correlationId ?? uuidv7();
    const trace = await captureJobTraceMeta(queue, { correlationId, tenantId });
    return {
      schemaVersion: 1,
      tenantId,
      actor: active?.meta.actor ?? { type: 'SYSTEM', userId: null, membershipId: null },
      correlationId,
      causationId: causationId !== undefined ? causationId : (active?.meta.causationId ?? null),
      ...(trace.traceparent ? { traceparent: trace.traceparent } : {}),
      ...(trace.tracestate ? { tracestate: trace.tracestate } : {}),
      enqueuedAt: this.now().toISOString(),
    };
  }
}
