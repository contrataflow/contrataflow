// Fixtures das filas (US-083): tenants, tipos de documento e operador semeados pelo superusuário,
// e um `QueueRuntime` real (Redis + PostgreSQL dos contêineres) com handlers de teste.
import type { JobData, JobMeta, QueueName } from '@contrataflow/types';
import type { Queue } from 'bullmq';

import type { TestPostgres } from './containers.js';
import type { QueueRuntimeConfig } from '../../src/config/queues.js';
import { JobHandlerRegistry } from '../../src/queues/job-handler-registry.js';
import { DEFAULT_JOB_OPTIONS } from '../../src/queues/queue-options.js';
import { QueueRuntime } from '../../src/queues/queue.runtime.js';
import type { JobHandler } from '../../src/queues/run-job.js';
import { RecordingQueueMetrics } from '../../src/queues/testing.js';

export const TENANT_A = '0192f0a0-0000-7000-8000-00000000000a';
export const TENANT_B = '0192f0a0-0000-7000-8000-00000000000b';
export const DOC_TYPE_A = '0192f0a0-0000-7000-8000-0000000000a1';
export const DOC_TYPE_B = '0192f0a0-0000-7000-8000-0000000000b1';
export const OPERATOR = '0192f0a0-0000-7000-8000-0000000000f1';
export const OPERATOR_SUBJECT = 'ops-subject-1';
export const NOT_OPERATOR = '0192f0a0-0000-7000-8000-0000000000f2';
export const NOT_OPERATOR_SUBJECT = 'ops-subject-2';

export async function seedQueueFixtures(db: TestPostgres): Promise<void> {
  await db.admin(`
    INSERT INTO tenants (id, slug, name, type, status, state_code) VALUES
      ('${TENANT_A}', 'prefeitura-a', 'Prefeitura A', 'MUNICIPALITY', 'ACTIVE', 'SC'),
      ('${TENANT_B}', 'prefeitura-b', 'Prefeitura B', 'MUNICIPALITY', 'ACTIVE', 'SC');
    INSERT INTO document_types (id, tenant_id, code, name, kind) VALUES
      ('${DOC_TYPE_A}', '${TENANT_A}', 'OFICIO', 'Ofício A', 'FREE_TEXT'),
      ('${DOC_TYPE_B}', '${TENANT_B}', 'OFICIO', 'Ofício B', 'FREE_TEXT');
    INSERT INTO users (id, external_subject, email, name, is_platform_operator) VALUES
      ('${OPERATOR}', '${OPERATOR_SUBJECT}', 'ops@contrataflow.test', 'Operadora de Plataforma', true),
      ('${NOT_OPERATOR}', '${NOT_OPERATOR_SUBJECT}', 'dev@contrataflow.test', 'Pessoa Dev', false);
  `);
}

export function jobMeta(tenantId: string | null, overrides: Partial<JobMeta> = {}): JobMeta {
  return {
    schemaVersion: 1,
    tenantId,
    actor: { type: 'SYSTEM', userId: null, membershipId: null },
    correlationId: 'corr-queue-it-1',
    causationId: null,
    enqueuedAt: new Date().toISOString(),
    ...overrides,
  };
}

export interface RunningRuntime {
  readonly runtime: QueueRuntime;
  readonly metrics: RecordingQueueMetrics;
  queue(name: QueueName): Queue;
  add(
    name: QueueName,
    jobName: string,
    data: JobData<unknown>,
    opts?: Record<string, unknown>,
  ): Promise<string>;
  stop(): Promise<void>;
}

/** Sobe um `QueueRuntime` (como uma réplica do worker) com os handlers de teste. */
export async function startRuntime(
  config: QueueRuntimeConfig,
  handlers: readonly JobHandler<never>[],
  register?: (runtime: QueueRuntime, registry: JobHandlerRegistry) => void,
): Promise<RunningRuntime> {
  const registry = new JobHandlerRegistry();
  for (const handler of handlers) registry.register(handler);
  const metrics = new RecordingQueueMetrics();
  const runtime = new QueueRuntime(config, registry, metrics);
  runtime.onModuleInit();
  register?.(runtime, registry);
  await runtime.onApplicationBootstrap();
  return {
    runtime,
    metrics,
    queue: (name) => runtime.queues.queue(name),
    add: async (name, jobName, data, opts = {}) => {
      const job = await runtime.queues
        .queue(name)
        .add(jobName, data, { ...DEFAULT_JOB_OPTIONS, ...opts });
      return job.id ?? '';
    },
    stop: () => runtime.onModuleDestroy(),
  };
}
