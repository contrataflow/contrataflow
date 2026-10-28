// Jobs dos módulos da API no worker (DEC-052 · queues.md §4.4/§4.5/§4.5.1): o `QueueRuntime` real
// consome as filas com o contexto de jobs da API (`@contrataflow/api/jobs`, sem HTTP) sobre
// PostgreSQL e Redis reais; Gotenberg e S3 são um dublê HTTP e a IA usa `AI_PROVIDER=fake`.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { loadJobsConfig, startApiJobs } from '@contrataflow/api/jobs';
import type { RunningApiJobs } from '@contrataflow/api/jobs';
import { DEFAULT_TEMPLATE_LAYOUT } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { adaptApiJob } from '../../src/api-jobs/api-jobs.js';
import type { JobHandler } from '../../src/queues/run-job.js';
import { startPostgres, startRedis } from '../support/containers.js';
import type { TestPostgres, TestRedis } from '../support/containers.js';
import {
  DOC_TYPE_A,
  TENANT_A,
  jobMeta,
  seedQueueFixtures,
  startRuntime,
} from '../support/queue-fixtures.js';
import type { RunningRuntime } from '../support/queue-fixtures.js';

const TEMPLATE = '0192f0a0-0000-7000-8000-0000000000d1';
const TEMPLATE_VERSION = '0192f0a0-0000-7000-8000-0000000000d2';
const RENDITIONS_BUCKET = 'cf-renditions';

/** PDF mínimo de uma página (o suficiente para a conferência do pipeline). */
const PDF = Buffer.from(
  '%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
    '3 0 obj << /Type /Page /Parent 2 0 R >> endobj\n%%EOF',
  'latin1',
);

interface Doubles {
  readonly url: string;
  readonly conversions: string[];
  readonly objects: Map<string, Buffer>;
  close(): Promise<void>;
}

/** Gotenberg (`/forms/chromium/convert/html`) e S3 path-style (`PUT /<bucket>/<chave>`). */
async function startDoubles(): Promise<Doubles> {
  const conversions: string[] = [];
  const objects = new Map<string, Buffer>();
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path = decodeURIComponent((request.url ?? '').split('?')[0] ?? '');
      if (request.method === 'POST' && path === '/forms/chromium/convert/html') {
        conversions.push(path);
        response.writeHead(200, { 'content-type': 'application/pdf' }).end(PDF);
        return;
      }
      if (request.method === 'PUT') {
        objects.set(path, Buffer.concat(chunks));
        response.writeHead(200, { etag: '"etag-1"' }).end();
        return;
      }
      response.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    conversions,
    objects,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

let db: TestPostgres;
let redis: TestRedis;
let doubles: Doubles;
let worker: RunningRuntime;
let apiJobs: RunningApiJobs;

beforeAll(async () => {
  Logger.overrideLogger(false);
  [db, redis, doubles] = await Promise.all([startPostgres(), startRedis(), startDoubles()]);
  await seedQueueFixtures(db);
  await db.admin(
    `INSERT INTO document_templates (id, tenant_id, document_type_id, name)
       VALUES ($1, $2, $3, 'Ofício padrão')`,
    [TEMPLATE, TENANT_A, DOC_TYPE_A],
  );
  await db.admin(
    `INSERT INTO document_template_versions (id, tenant_id, template_id, version_number, status, layout)
       VALUES ($1, $2, $3, 1, 'DRAFT', $4::jsonb)`,
    [TEMPLATE_VERSION, TENANT_A, TEMPLATE, JSON.stringify(DEFAULT_TEMPLATE_LAYOUT)],
  );
  worker = await startRuntime(
    { appEnv: 'test', redisUrl: redis.url, workerDatabaseUrl: db.url('cf_worker'), admin: null },
    [],
  );
  // Mesmo `.env` da API, no modo "jobs"; sem CLAMAV_HOST a varredura fica pausada.
  apiJobs = await startApiJobs({
    logger: false,
    config: loadJobsConfig({
      APP_ENV: 'test',
      DATABASE_URL: db.url('cf_app'),
      DATABASE_URL_PLATFORM: db.url('cf_platform'),
      REDIS_CACHE_URL: redis.url,
      AI_PROVIDER: 'fake',
      GOTENBERG_URL: doubles.url,
      S3_ENDPOINT: doubles.url,
      S3_FORCE_PATH_STYLE: 'true',
      S3_ACCESS_KEY_ID: 'test-only',
      S3_SECRET_ACCESS_KEY: 'test-only-secret',
      S3_BUCKET_QUARANTINE: 'cf-quarantine',
      S3_BUCKET_DOCUMENTS: 'cf-documents',
      S3_BUCKET_RENDITIONS: RENDITIONS_BUCKET,
    }),
  });
  worker.runtime.consume(
    apiJobs.handlers.map((handler) => adaptApiJob(handler) as JobHandler<never>),
  );
});

afterAll(async () => {
  await worker.stop();
  await apiJobs.close();
  await Promise.all([db.stop(), redis.stop(), doubles.close()]);
});

/** Redis do contêiner pela conexão da própria fila (o teste semeia o estado da prévia). */
const raw = () => worker.queue('document-render').client;

const previewKey = (renditionId: string) =>
  `cf:test:t:${TENANT_A}:template-preview:preview:${renditionId}`;

describe('jobs dos módulos da API no worker (DEC-052) — integração', () => {
  it('liga document-render e ai-generation; file-scan fica pausada sem ClamAV', () => {
    expect(apiJobs.handlers.map((handler) => `${handler.queue}/${handler.name}`)).toEqual([
      'document-render/render',
      'document-render/template-preview',
      'ai-generation/generate',
    ]);
    expect(apiJobs.paused).toEqual([
      { queue: 'file-scan', name: 'scan', missing: ['CLAMAV_HOST'] },
    ]);
  });

  it('[Sucesso] prévia do template: PENDING → READY com o PDF no bucket renditions', async () => {
    const renditionId = randomUUID();
    const now = new Date();
    const redisClient = await raw();
    // Sem TTL: o Redis é do contêiner do teste.
    await redisClient.set(
      previewKey(renditionId),
      JSON.stringify({
        renditionId,
        tenantId: TENANT_A,
        templateVersionId: TEMPLATE_VERSION,
        templateVersionRevision: 1,
        requestedById: null,
        status: 'PENDING',
        storageKey: null,
        sha256: null,
        sizeBytes: null,
        pageCount: null,
        errorCode: null,
        errorMessage: null,
        requestedAt: now.toISOString(),
        startedAt: null,
        readyAt: null,
        expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
      }),
    );
    const id = await worker.add(
      'document-render',
      'template-preview',
      {
        meta: jobMeta(TENANT_A),
        payload: { renditionId, templateVersionId: TEMPLATE_VERSION },
      },
      { jobId: renditionId },
    );
    await vi.waitFor(
      async () => {
        expect(await worker.queue('document-render').getJobState(id)).toBe('completed');
      },
      { timeout: 30_000 },
    );
    const state = JSON.parse((await redisClient.get(previewKey(renditionId))) ?? '{}') as {
      status: string;
      storageKey: string;
      pageCount: number;
    };
    expect(state).toMatchObject({ status: 'READY', pageCount: 1 });
    expect(doubles.conversions).toHaveLength(1);
    const stored = doubles.objects.get(`/${RENDITIONS_BUCKET}/${state.storageKey}`);
    expect(stored?.includes('%PDF-')).toBe(true);
    expect(worker.metrics.processed).toContainEqual({
      queue: 'document-render',
      jobName: 'template-preview',
      outcome: 'completed',
    });
  });

  it('[Sucesso] ai-generation (AI_PROVIDER=fake) chega ao handler da API no tenant do job', async () => {
    // Geração inexistente no tenant A: o processor da API lê pela RLS e conclui sem efeito.
    const id = await worker.add(
      'ai-generation',
      'generate',
      { meta: jobMeta(TENANT_A), payload: { generationId: randomUUID() } },
      { jobId: randomUUID() },
    );
    await vi.waitFor(
      async () => {
        expect(await worker.queue('ai-generation').getJobState(id)).toBe('completed');
      },
      { timeout: 30_000 },
    );
    expect((await worker.queue('ai-generation').getJob(id))?.returnvalue).toBe('completed');
  });

  it('[Validação] payload inválido para a API vai para a dead-letter sem retry', async () => {
    const id = await worker.add(
      'ai-generation',
      'generate',
      { meta: jobMeta(TENANT_A), payload: { generationId: 'x' } },
      { jobId: 'ai-invalid-1' },
    );
    await vi.waitFor(
      async () => {
        expect(await worker.queue('ai-generation').getJobState(id)).toBe('failed');
      },
      { timeout: 30_000 },
    );
    expect((await worker.queue('ai-generation').getJob(id))?.failedReason).toBe(
      'INVALID_JOB_PAYLOAD',
    );
    expect(await worker.queue('dead-letter').getJob('ai-generation.ai-invalid-1')).toBeDefined();
  });

  it('file-scan sem consumidor: o job espera na fila até a configuração', async () => {
    const id = await worker.add(
      'file-scan',
      'scan',
      { meta: jobMeta(TENANT_A), payload: { attachmentId: randomUUID() } },
      { jobId: randomUUID() },
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await worker.queue('file-scan').getJobState(id)).toBe('waiting');
  });
});
