// Integração com PostgreSQL e Redis reais (Testcontainers): `/health/ready` com as dependências no
// ar e paradas, e o cache de 5 s (US-085 — "Testes necessários › Integração"). Executado por
// `pnpm --filter @contrataflow/api test:integration`.
import type { HealthResponse } from '@contrataflow/observability';
import request from 'supertest';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { postgresImage } from '../database/support/postgres.js';
import { createTestApi, testConfig } from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';

/** Mesma imagem do Compose local (infra/docker-compose.yml). */
const REDIS_IMAGE =
  'redis:7.4.11-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499';

async function ready(api: TestApi): Promise<{ status: number; body: HealthResponse }> {
  const response = await request(api.server).get('/health/ready');
  return { status: response.status, body: JSON.parse(response.text) as HealthResponse };
}

describe('/health/ready com PostgreSQL e Redis reais', () => {
  let postgres: StartedTestContainer;
  let redis: StartedTestContainer;
  let api: TestApi;

  beforeAll(async () => {
    [postgres, redis] = await Promise.all([
      new GenericContainer(postgresImage())
        .withEnvironment({ POSTGRES_PASSWORD: 'test-only', POSTGRES_DB: 'contrataflow' })
        .withExposedPorts(5432)
        .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
        .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
        .start(),
      new GenericContainer(REDIS_IMAGE).withExposedPorts(6379).start(),
    ]);
    api = await createTestApi({
      stores: 'redis',
      config: testConfig({
        DATABASE_URL: `postgresql://postgres:test-only@${postgres.getHost()}:${String(postgres.getMappedPort(5432))}/contrataflow`,
        REDIS_CACHE_URL: `redis://${redis.getHost()}:${String(redis.getMappedPort(6379))}`,
        // Cache curto: cada etapa do teste enxerga o estado novo das dependências.
        HEALTH_CACHE_TTL_MS: '200',
      }),
    });
  });

  afterAll(async () => {
    await api.close();
    await Promise.allSettled([postgres.stop(), redis.stop()]);
  });

  it('[Sucesso] tudo no ar → 200 pass, com o tempo de resposta de cada dependência', async () => {
    // O cliente Redis conecta em segundo plano no bootstrap.
    await vi.waitFor(async () => {
      expect((await ready(api)).body.status).toBe('pass');
    });
    const { status, body } = await ready(api);
    expect(status).toBe(200);
    expect(body.checks?.['postgresql:responseTime']?.[0]).toMatchObject({
      status: 'pass',
      observedUnit: 'ms',
    });
  });

  it('[Duplicidade] dentro da janela de cache o resultado é o mesmo, sem nova verificação', async () => {
    const cached = await createTestApi({
      stores: 'redis',
      config: { ...api.config, health: { cacheTtlMs: 5_000, checkTimeoutMs: null } },
    });
    try {
      await vi.waitFor(async () => {
        expect((await ready(cached)).body.status).not.toBe('fail');
      });
      const first = await request(cached.server).get('/health/ready');
      const second = await request(cached.server).get('/health/ready');
      expect(second.text).toBe(first.text);
    } finally {
      await cached.close();
    }
  });

  it('[Falha de integração] Redis parado → 200 warn; o check do Redis é warn, não fail', async () => {
    await redis.stop();
    await vi.waitFor(async () => {
      expect((await ready(api)).body.status).toBe('warn');
    });
    const { status, body } = await ready(api);
    expect(status).toBe(200);
    expect(body.checks?.['redis-cache:responseTime']?.[0]?.status).toBe('warn');
    // Sem host nem endereço no corpo (RN-FND-80).
    expect(JSON.stringify(body)).not.toMatch(/localhost|\d+\.\d+\.\d+\.\d+|6379/);
  });

  it('[Falha de banco] PostgreSQL parado → 503 fail com o check postgresql em fail', async () => {
    await postgres.stop();
    await vi.waitFor(
      async () => {
        expect((await ready(api)).status).toBe(503);
      },
      { timeout: 15_000, interval: 300 },
    );
    const { body } = await ready(api);
    expect(body.status).toBe('fail');
    expect(body.checks?.['postgresql:responseTime']?.[0]?.status).toBe('fail');
  });
});
