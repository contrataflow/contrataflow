// Integração com Redis real (Testcontainers): throttler, idempotência e degradação (US-080 —
// "Testes necessários › Integração"). Executado por `pnpm --filter @contrataflow/api test:integration`.
import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import request from 'supertest';
import { GenericContainer } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi, testConfig } from './support/api-test-app.js';
import type { TestApi } from './support/api-test-app.js';
import { Gate, PipelineTestController, slowGate } from './support/test-controllers.js';

/** Mesma imagem do Compose local (infra/docker-compose.yml). */
const REDIS_IMAGE =
  'redis:7.4.11-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499';

const A = FAKE_TENANTS.prefeituraA.id;

describe('pipeline com Redis real', () => {
  let redis: StartedTestContainer;
  let api: TestApi;
  let redisUrl: string;
  let stopped = false;

  beforeAll(async () => {
    redis = await new GenericContainer(REDIS_IMAGE).withExposedPorts(6379).start();
    redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    api = await createTestApi({
      stores: 'redis',
      config: testConfig({ REDIS_CACHE_URL: redisUrl, RATE_LIMIT_READ_PER_MIN: '3' }),
      controllers: [PipelineTestController],
    });
    // Aguarda a conexão inicial (o cliente conecta em segundo plano no bootstrap): enquanto não
    // conecta, o rate limit falha aberto e não devolve `RateLimit-*`. Carla não é usada adiante.
    await vi.waitFor(
      async () => {
        const response = await request(api.server)
          .get('/api/v1/_test/without-tenant')
          .set('Authorization', api.bearer(FAKE_USERS.carla.subject));
        expect(response.headers['ratelimit-limit']).toBeDefined();
      },
      { timeout: 10_000, interval: 100 },
    );
  });

  afterAll(async () => {
    await api.close();
    if (!stopped) await redis.stop();
  });

  const read = (subject: string = FAKE_USERS.ana.subject) =>
    request(api.server)
      .get('/api/v1/_internal/ping')
      .set('Authorization', api.bearer(subject))
      .set('X-Tenant-Id', A);

  it('throttler por classe: o limite de leitura vale entre requisições e responde 429', async () => {
    const statuses: number[] = [];
    for (let index = 0; index < 4; index += 1) statuses.push((await read()).status);
    expect(statuses).toEqual([200, 200, 200, 429]);

    const limited = await read();
    expect(limited.body).toMatchObject({ code: 'RATE_LIMITED' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);

    const keys = await redis.exec(['redis-cli', '--scan', '--pattern', `cf:test:t:${A}:rl:*`]);
    expect(keys.output).toContain(`cf:test:t:${A}:rl:read:${FAKE_USERS.ana.id}:`);
    expect(keys.output).toContain(`cf:test:t:${A}:rl:tenant:`);
  });

  it('idempotência: replay, corpo diferente e chave isolada por tenant no Redis', async () => {
    const key = randomUUID();
    const send = (body: object) =>
      request(api.server)
        .post('/api/v1/_internal/echo')
        .set('Authorization', api.bearer(FAKE_USERS.ana.subject))
        .set('X-Tenant-Id', A)
        .set('Idempotency-Key', key)
        .send(body);

    const first = await send({ name: 'Caneta' });
    const replay = await send({ name: 'Caneta' });
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect((await send({ name: 'Lápis' })).body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });

    const stored = await redis.exec(['redis-cli', '--scan', '--pattern', `cf:test:t:${A}:idem:*`]);
    expect(stored.output.trim().split('\n').length).toBeGreaterThanOrEqual(1);
    const ttl = await redis.exec(['redis-cli', 'PTTL', stored.output.trim().split('\n')[0] ?? '']);
    expect(Number(ttl.output.trim())).toBeGreaterThan(23 * 3_600_000);
  });

  it('idempotência: requisições simultâneas com a mesma chave → uma processa, a outra 409', async () => {
    slowGate.current = new Gate();
    const key = randomUUID();
    const send = () =>
      request(api.server)
        .post('/api/v1/_test/slow')
        .set('Authorization', api.bearer(FAKE_USERS.ana.subject))
        .set('X-Tenant-Id', A)
        .set('Idempotency-Key', key)
        .send({});

    const first = send().then((response) => response);
    await slowGate.current.entered;
    const second = await send();
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS' });
    slowGate.current.open();
    expect((await first).status).toBe(201);
  });

  // Último cenário: derruba o Redis de vez (o afterAll tolera o contêiner já parado).
  it('CA-T-07: com o Redis fora, leitura e escrita seguem (falha aberta) com log warn', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    await redis.stop();
    stopped = true;
    try {
      const response = await read(FAKE_USERS.ana.subject);
      expect(response.status).toBe(200);
      const write = await request(api.server)
        .post('/api/v1/_internal/echo')
        .set('Authorization', api.bearer(FAKE_USERS.ana.subject))
        .set('X-Tenant-Id', A)
        .set('Idempotency-Key', randomUUID())
        .send({ name: 'sem Redis' });
      expect(write.status).toBe(201);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^throttler\.store_unavailable/));
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^idempotency\.store_unavailable/));
    } finally {
      warn.mockRestore();
    }
  });
});
