// Presença de edição sobre Redis real (US-070 · DEC-055 · RN-DOC-88/89/91/92 · "Testes necessários
// › Integração"): o script atômico do heartbeat (poda + grava + renova TTL + lista) em
// `cf:{env}:t:{tenantId}:presence:document:{documentId}` (`ZSET`) e `…:sections` (`HASH`); TTL
// renovado a cada heartbeat; expiração sem heartbeat; concorrência sem sobrescrita; tenant isolado
// pelo prefixo; Redis fora do ar → erro imediato (o caso de uso falha aberto). Executado por
// `pnpm --filter @contrataflow/api test:integration`.
import { Logger } from '@nestjs/common';
import { GenericContainer } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RedisDocumentPresenceStore } from '#modules/platform/infrastructure/redis/redis-document-presence.store.js';
import { RedisClient } from '#modules/platform/infrastructure/redis/redis.client.js';
import { FAKE_TENANTS } from '#shared/testing/fake-directory.js';

import { testConfig } from '../support/api-test-app.js';

/** Mesma imagem do Compose local (infra/docker-compose.yml). */
const REDIS_IMAGE =
  'redis:7.4.11-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499';

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const DOCUMENT = '0192d070-0000-7000-8000-0000000000d1';
const ANA = '0192d070-0000-7000-8000-0000000000e1';
const BRUNO = '0192d070-0000-7000-8000-0000000000e2';
const TTL = 60_000;

describe('presença de edição com Redis real (US-070)', () => {
  let redis: StartedTestContainer;
  let client: RedisClient;
  let store: RedisDocumentPresenceStore;
  let stopped = false;

  const keyOf = (tenantId: string, documentId = DOCUMENT) =>
    `cf:test:t:${tenantId}:presence:document:${documentId}`;

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    redis = await new GenericContainer(REDIS_IMAGE).withExposedPorts(6379).start();
    const config = testConfig({
      REDIS_CACHE_URL: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
    });
    client = new RedisClient(config);
    await client.redis.connect();
    store = new RedisDocumentPresenceStore(client, config);
  }, 120_000);

  afterAll(async () => {
    client.onModuleDestroy();
    if (!stopped) await redis.stop();
    vi.restoreAllMocks();
  });

  it('heartbeat grava uma entrada por usuário, mantém o `since` na mesma seção e renova o TTL para 60 s', async () => {
    const start = Date.now();
    await store.touch({
      tenantId: A,
      documentId: DOCUMENT,
      userId: ANA,
      sectionKey: 'JUSTIFICATIVA',
      now: new Date(start),
      ttlMs: TTL,
    });
    await client.redis.pexpire(keyOf(A), 10_000);
    const entries = await store.touch({
      tenantId: A,
      documentId: DOCUMENT,
      userId: ANA,
      sectionKey: 'JUSTIFICATIVA',
      now: new Date(start + 5_000),
      ttlMs: TTL,
    });
    expect(entries).toEqual([
      {
        userId: ANA,
        sectionKey: 'JUSTIFICATIVA',
        since: new Date(start),
        lastSeenAt: new Date(start + 5_000),
      },
    ]);
    expect(await client.redis.zcard(keyOf(A))).toBe(1);
    for (const key of [keyOf(A), `${keyOf(A)}:sections`]) {
      const ttl = await client.redis.pttl(key);
      expect(ttl).toBeGreaterThan(TTL - 2_000);
      expect(ttl).toBeLessThanOrEqual(TTL);
    }

    // Trocar de seção atualiza a seção e o `since`; heartbeat sem seção mantém a anterior.
    const moved = await store.touch({
      tenantId: A,
      documentId: DOCUMENT,
      userId: ANA,
      sectionKey: 'REQUISITOS',
      now: new Date(start + 10_000),
      ttlMs: TTL,
    });
    expect(moved[0]).toMatchObject({ sectionKey: 'REQUISITOS', since: new Date(start + 10_000) });
    const kept = await store.touch({
      tenantId: A,
      documentId: DOCUMENT,
      userId: ANA,
      sectionKey: null,
      now: new Date(start + 15_000),
      ttlMs: TTL,
    });
    expect(kept[0]).toMatchObject({ sectionKey: 'REQUISITOS', since: new Date(start + 10_000) });

    await store.remove({ tenantId: A, documentId: DOCUMENT, userId: ANA });
    expect(await client.redis.zcard(keyOf(A))).toBe(0);
    expect(await client.redis.hlen(`${keyOf(A)}:sections`)).toBe(0);
  });

  it('poda quem passou de 60 s sem heartbeat e as chaves expiram sozinhas sem heartbeat', async () => {
    const document = '0192d070-0000-7000-8000-0000000000d2';
    const start = Date.now();
    await store.touch({
      tenantId: A,
      documentId: document,
      userId: BRUNO,
      sectionKey: 'JUSTIFICATIVA',
      now: new Date(start - TTL),
      ttlMs: TTL,
    });
    const entries = await store.touch({
      tenantId: A,
      documentId: document,
      userId: ANA,
      sectionKey: 'JUSTIFICATIVA',
      now: new Date(start),
      ttlMs: TTL,
    });
    expect(entries.map((entry) => entry.userId)).toEqual([ANA]);
    expect(await client.redis.hget(`${keyOf(A, document)}:sections`, `${BRUNO}:s`)).toBeNull();

    // TTL curto: sem novo heartbeat, as duas chaves somem pelo próprio Redis (RN-DOC-89).
    await store.touch({
      tenantId: A,
      documentId: document,
      userId: ANA,
      sectionKey: 'JUSTIFICATIVA',
      now: new Date(),
      ttlMs: 300,
    });
    await vi.waitFor(
      async () => {
        expect(
          await client.redis.exists(keyOf(A, document), `${keyOf(A, document)}:sections`),
        ).toBe(0);
      },
      { timeout: 3_000, interval: 100 },
    );
  });

  it('dois heartbeats simultâneos de usuários diferentes não se sobrescrevem', async () => {
    const document = '0192d070-0000-7000-8000-0000000000d3';
    const now = new Date();
    const users = Array.from(
      { length: 20 },
      (_, index) => `0192d070-0000-7000-8000-${String(index).padStart(12, '0')}`,
    );
    await Promise.all(
      users.map((userId) =>
        store.touch({
          tenantId: A,
          documentId: document,
          userId,
          sectionKey: 'JUSTIFICATIVA',
          now,
          ttlMs: TTL,
        }),
      ),
    );
    const entries = await store.touch({
      tenantId: A,
      documentId: document,
      userId: users[0] ?? '',
      sectionKey: 'JUSTIFICATIVA',
      now,
      ttlMs: TTL,
    });
    expect(entries.map((entry) => entry.userId).sort()).toEqual([...users].sort());
  });

  it('isolamento por tenant: a mesma chave relativa em outro tenant é outro conjunto', async () => {
    const document = '0192d070-0000-7000-8000-0000000000d4';
    const now = new Date();
    await store.touch({
      tenantId: A,
      documentId: document,
      userId: ANA,
      sectionKey: null,
      now,
      ttlMs: TTL,
    });
    const fromB = await store.touch({
      tenantId: B,
      documentId: document,
      userId: BRUNO,
      sectionKey: null,
      now,
      ttlMs: TTL,
    });
    expect(fromB.map((entry) => entry.userId)).toEqual([BRUNO]);
    expect(await client.redis.zrange(keyOf(A, document), 0, -1)).toEqual([ANA]);
    expect(await client.redis.zrange(keyOf(B, document), 0, -1)).toEqual([BRUNO]);
  });

  it('Redis fora do ar: o heartbeat falha na hora (sem segurar a requisição) — o caso de uso degrada', async () => {
    await redis.stop();
    stopped = true;
    const started = Date.now();
    await expect(
      store.touch({
        tenantId: A,
        documentId: DOCUMENT,
        userId: ANA,
        sectionKey: null,
        now: new Date(),
        ttlMs: TTL,
      }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
