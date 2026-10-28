import type { QueueName } from '@contrataflow/types';
import { Logger } from '@nestjs/common';
import type { INestApplicationContext, LoggerService, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { z } from 'zod';

import type { AppConfig } from '#config/env.js';
import {
  AI_GENERATION_JOB,
  AI_GENERATION_QUEUE,
  AiGenerationJob,
} from '#modules/ai/application/ai-generation.job.js';
import {
  DOCUMENT_RENDER_JOB,
  DOCUMENT_RENDER_QUEUE,
  RenderDocumentJob,
} from '#modules/document/application/render-document.job.js';
import {
  RenderTemplatePreviewJob,
  TEMPLATE_PREVIEW_JOB,
} from '#modules/document/application/render-template-preview.job.js';
import {
  FILE_SCAN_JOB,
  FILE_SCAN_QUEUE,
  ScanFileJob,
} from '#modules/files/application/scan-file.job.js';
import { RedisClient } from '#modules/platform/infrastructure/redis/redis.client.js';
import type { TenantJob, TenantJobOutcome, TenantJobRun } from '#shared/jobs/tenant-job.js';

import { ApiJobsModule } from './api-jobs.module.js';

/*
 * Entrada pública `@contrataflow/api/jobs` (DEC-052 · architecture.md §4.3): o worker liga as filas
 * dos módulos da API pelo limite de pacote — nunca por alias de caminho. Os `#shared/*`/`#config/*`
 * deste código resolvem pelo `package.json` da API (Node subpath imports), por isso não colidem com
 * os do worker. O worker recebe handlers prontos e os executa pelo seu `runJob` (timeouts,
 * concorrência, classificação de erros e dead-letter de `queue-options`).
 */

export { ConfigValidationError, loadJobsConfig } from '#config/env.js';
export type { AppConfig } from '#config/env.js';
export type { TenantJobOutcome, TenantJobRun } from '#shared/jobs/tenant-job.js';
export { classifyApiJobFailure } from './job-failures.js';
export type { ApiJobFailure } from './job-failures.js';

/** Handler de um par fila/job da API, já resolvido no contexto de jobs. */
export interface ApiJobHandler {
  readonly queue: QueueName;
  readonly name: string;
  readonly payloadSchema: z.ZodType;
  /** Valida `meta`/payload, restaura o contexto do tenant e do ator e executa o caso de uso. */
  process(run: TenantJobRun): Promise<TenantJobOutcome>;
}

/** Job sem consumidor por falta de configuração (contrato de `env.ts`: `null` = fila pausada). */
export interface PausedApiJob {
  readonly queue: QueueName;
  readonly name: string;
  /** Variáveis ausentes (só as chaves). */
  readonly missing: readonly string[];
}

export interface StartApiJobsOptions {
  readonly config: AppConfig;
  /** Logger do Nest do processo hospedeiro (o pino do worker); `false` silencia (testes). */
  readonly logger?: LoggerService | false;
  /** Espera máxima pelo Redis principal antes de entregar os handlers (padrão 10 s). */
  readonly redisReadyTimeoutMs?: number;
}

export interface RunningApiJobs {
  readonly handlers: readonly ApiJobHandler[];
  readonly paused: readonly PausedApiJob[];
  /** Encerra o contexto (pools do banco, Redis, clientes S3) — depois dos `Worker`s do BullMQ. */
  close(): Promise<void>;
}

const S3_KEYS = ['S3_BUCKET_QUARANTINE', 'S3_BUCKET_DOCUMENTS', 'S3_BUCKET_RENDITIONS'];

function storageMissing(config: AppConfig): string[] {
  return config.storage.s3 === null ? S3_KEYS : [];
}

/** PDF (US-067/US-109): Gotenberg e o bucket de renditions. */
function renderMissing(config: AppConfig): string[] {
  return [...(config.pdf === null ? ['GOTENBERG_URL'] : []), ...storageMissing(config)];
}

/** Varredura (US-068): ClamAV e os buckets de quarentena/documentos. */
function scanMissing(config: AppConfig): string[] {
  return [...(config.antivirus === null ? ['CLAMAV_HOST'] : []), ...storageMissing(config)];
}

interface ApiJobSpec {
  readonly queue: QueueName;
  readonly name: string;
  readonly type: Type<TenantJob<unknown>>;
  readonly missing: (config: AppConfig) => string[];
}

/** Os jobs dos módulos da API consumidos pelo worker (queues.md §4.4, §4.5, §4.5.1). */
const API_JOBS: readonly ApiJobSpec[] = [
  {
    queue: DOCUMENT_RENDER_QUEUE,
    name: DOCUMENT_RENDER_JOB,
    type: RenderDocumentJob,
    missing: renderMissing,
  },
  {
    queue: DOCUMENT_RENDER_QUEUE,
    name: TEMPLATE_PREVIEW_JOB,
    type: RenderTemplatePreviewJob,
    missing: renderMissing,
  },
  { queue: FILE_SCAN_QUEUE, name: FILE_SCAN_JOB, type: ScanFileJob, missing: scanMissing },
  // Sem provedor (`AI_PROVIDER=none`) a API recusa o pedido (503): a fila fica sempre ligada.
  { queue: AI_GENERATION_QUEUE, name: AI_GENERATION_JOB, type: AiGenerationJob, missing: () => [] },
];

/**
 * O `RedisClient` da API conecta em segundo plano e, sem fila offline, recusa comandos até ficar
 * pronto: o `TenantCache` degrada para "ausente" e a prévia do template (estado no Redis) seria
 * descartada como SKIPPED. Os jobs já parados na fila chegam logo no início — espera o `ready`.
 */
async function redisReady(context: INestApplicationContext, timeoutMs: number): Promise<boolean> {
  const { redis } = context.get(RedisClient, { strict: false });
  if (redis.status === 'ready') return true;
  return new Promise((resolve) => {
    const onReady = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      redis.off('ready', onReady);
      resolve(false);
    }, timeoutMs);
    redis.once('ready', onReady);
  });
}

/**
 * Sobe o contexto Nest da API sem HTTP (`ApiJobsModule`) e devolve os handlers das filas cuja
 * configuração existe; os demais saem em `paused` (a fila espera no Redis até a configuração).
 */
export async function startApiJobs(options: StartApiJobsOptions): Promise<RunningApiJobs> {
  const { config } = options;
  const context = await NestFactory.createApplicationContext(ApiJobsModule.forRoot(config), {
    // Erro de DI vira exceção para o worker tratar (o padrão encerraria o processo).
    abortOnError: false,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  if (!(await redisReady(context, options.redisReadyTimeoutMs ?? 10_000))) {
    // Segue: o cliente reconecta sozinho; até lá os jobs degradam como na API (CA-T-07).
    new Logger('ApiJobs').warn({ event: 'worker.api_jobs_redis_not_ready' }, 'redis not ready');
  }
  const handlers: ApiJobHandler[] = [];
  const paused: PausedApiJob[] = [];
  for (const spec of API_JOBS) {
    const missing = spec.missing(config);
    if (missing.length > 0) {
      paused.push({ queue: spec.queue, name: spec.name, missing });
      continue;
    }
    const job = context.get(spec.type, { strict: false });
    handlers.push({
      queue: spec.queue,
      name: spec.name,
      payloadSchema: job.payloadContract,
      process: (run) => job.process(run),
    });
  }
  return { handlers, paused, close: () => context.close() };
}
