import { EventEmitter } from 'node:events';

import { NestFactory } from '@nestjs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadJobsConfig } from '#config/env.js';
import { RedisClient } from '#modules/platform/infrastructure/redis/redis.client.js';
import type { TenantJobRun } from '#shared/jobs/tenant-job.js';

import { startApiJobs } from './index.js';

const BASE = {
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://cf_app:devpassword@localhost:5432/contrataflow',
  REDIS_CACHE_URL: 'redis://localhost:6380',
};

const CONFIGURED = {
  ...BASE,
  GOTENBERG_URL: 'http://gotenberg:3000',
  CLAMAV_HOST: 'clamav',
  S3_ENDPOINT: 'http://minio:9000',
  S3_BUCKET_QUARANTINE: 'cf-quarantine',
  S3_BUCKET_DOCUMENTS: 'cf-documents',
  S3_BUCKET_RENDITIONS: 'cf-renditions',
};

/** Cliente ioredis falso: `status` e o evento `ready`. */
class FakeRedis extends EventEmitter {
  constructor(public status: string) {
    super();
  }
}

/** Contexto Nest falso: cada `TenantJob` vira um dublê com `payloadContract` e `process`. */
function fakeContext(redis = new FakeRedis('ready')) {
  const processed: TenantJobRun[] = [];
  const close = vi.fn(() => Promise.resolve());
  const jobs = vi.fn<(type: { name: string }) => unknown>();
  const context = {
    get: (type: { name: string }) => (type === RedisClient ? { redis } : jobs(type)),
    jobs,
    close,
  };
  jobs.mockImplementation((type: { name: string }) => ({
    payloadContract: { type: type.name },
    process: (run: TenantJobRun) => {
      processed.push(run);
      return Promise.resolve('completed' as const);
    },
  }));
  const create = vi
    .spyOn(NestFactory, 'createApplicationContext')
    .mockResolvedValue(context as never);
  return { context, processed, close, create };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startApiJobs (@contrataflow/api/jobs · DEC-052)', () => {
  it('entrega os quatro jobs dos módulos da API quando a configuração existe', async () => {
    const { context, processed, close, create } = fakeContext();
    const running = await startApiJobs({ config: loadJobsConfig(CONFIGURED), logger: false });
    expect(running.paused).toEqual([]);
    expect(running.handlers.map((handler) => `${handler.queue}/${handler.name}`)).toEqual([
      'document-render/render',
      'document-render/template-preview',
      'file-scan/scan',
      'ai-generation/generate',
    ]);
    expect(running.handlers[0]?.payloadSchema).toEqual({ type: 'RenderDocumentJob' });
    expect(create).toHaveBeenCalledWith(expect.anything(), {
      abortOnError: false,
      logger: false,
    });
    const run: TenantJobRun = {
      id: 'j1',
      queue: 'file-scan',
      name: 'scan',
      attempt: 1,
      data: { meta: {}, payload: {} },
    };
    await expect(running.handlers[2]?.process(run)).resolves.toBe('completed');
    expect(processed).toEqual([run]);
    expect(context.jobs).toHaveBeenCalledTimes(4);
    await running.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('sem Gotenberg, S3 e ClamAV pausa as filas que dependem deles (null = fila pausada)', async () => {
    const { context, create } = fakeContext();
    const running = await startApiJobs({ config: loadJobsConfig(BASE) });
    expect(running.handlers.map((handler) => handler.queue)).toEqual(['ai-generation']);
    expect(running.paused).toEqual([
      {
        queue: 'document-render',
        name: 'render',
        missing: [
          'GOTENBERG_URL',
          'S3_BUCKET_QUARANTINE',
          'S3_BUCKET_DOCUMENTS',
          'S3_BUCKET_RENDITIONS',
        ],
      },
      {
        queue: 'document-render',
        name: 'template-preview',
        missing: [
          'GOTENBERG_URL',
          'S3_BUCKET_QUARANTINE',
          'S3_BUCKET_DOCUMENTS',
          'S3_BUCKET_RENDITIONS',
        ],
      },
      {
        queue: 'file-scan',
        name: 'scan',
        missing: [
          'CLAMAV_HOST',
          'S3_BUCKET_QUARANTINE',
          'S3_BUCKET_DOCUMENTS',
          'S3_BUCKET_RENDITIONS',
        ],
      },
    ]);
    // Sem `logger`, o Nest usa o padrão do hospedeiro.
    expect(create).toHaveBeenCalledWith(expect.anything(), {
      abortOnError: false,
    });
    expect(context.jobs).toHaveBeenCalledOnce();
  });

  it('só o ClamAV ausente pausa só a varredura', async () => {
    fakeContext();
    const { CLAMAV_HOST: _clamav, ...withoutClamav } = CONFIGURED;
    const running = await startApiJobs({ config: loadJobsConfig(withoutClamav), logger: false });
    expect(running.paused).toEqual([
      { queue: 'file-scan', name: 'scan', missing: ['CLAMAV_HOST'] },
    ]);
    expect(running.handlers).toHaveLength(3);
  });

  it('espera o Redis principal ficar pronto antes de entregar os handlers', async () => {
    const redis = new FakeRedis('connecting');
    fakeContext(redis);
    let started = false;
    const starting = startApiJobs({ config: loadJobsConfig(CONFIGURED), logger: false }).then(
      (running) => {
        started = true;
        return running;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toBe(false);
    redis.status = 'ready';
    redis.emit('ready');
    await expect(starting).resolves.toMatchObject({ paused: [] });
    expect(redis.listenerCount('ready')).toBe(0);
  });

  it('Redis fora no prazo: segue com os handlers (o cliente reconecta sozinho)', async () => {
    const redis = new FakeRedis('reconnecting');
    fakeContext(redis);
    const running = await startApiJobs({
      config: loadJobsConfig(CONFIGURED),
      logger: false,
      redisReadyTimeoutMs: 10,
    });
    expect(running.handlers).toHaveLength(4);
    expect(redis.listenerCount('ready')).toBe(0);
  });
});
