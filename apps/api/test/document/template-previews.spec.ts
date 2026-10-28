// Prévia efêmera do template sobre Redis real (US-109 · RN-TPL-26 · "Testes necessários ›
// Integração"): o estado vive em `cf:{env}:t:{tenantId}:template-preview:…` com TTL de 24 h, a
// trava `SET NX` deduplica os cliques e o tenant do contexto isola as chaves. Executado por
// `pnpm --filter @contrataflow/api test:integration`.
import { GenericContainer } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { TemplatePreviewStore } from '#modules/document/application/template-preview.store.js';
import { requestTemplatePreview } from '#modules/document/domain/template-preview.js';
import { RedisClient } from '#modules/platform/infrastructure/redis/redis.client.js';
import { FAKE_TENANTS } from '#shared/testing/fake-directory.js';

import { asTenant } from '../database/support/postgres.js';
import { createTestApi, testConfig } from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';

/** Mesma imagem do Compose local (infra/docker-compose.yml). */
const REDIS_IMAGE =
  'redis:7.4.11-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499';

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const VERSION = '0192d109-0000-7000-8000-0000000000d1';
const RENDITION = '0192d109-0000-7000-8000-0000000000d2';
const OTHER = '0192d109-0000-7000-8000-0000000000d3';

describe('prévia efêmera do template com Redis real (US-109)', () => {
  let redis: StartedTestContainer;
  let api: TestApi;

  beforeAll(async () => {
    redis = await new GenericContainer(REDIS_IMAGE).withExposedPorts(6379).start();
    const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    api = await createTestApi({
      stores: 'redis',
      config: testConfig({ REDIS_CACHE_URL: redisUrl }),
    });
    // O cliente conecta em segundo plano no bootstrap e, sem fila offline, recusa comandos antes.
    const client = api.app.get(RedisClient, { strict: false }).redis;
    await vi.waitFor(
      () => {
        expect(client.status).toBe('ready');
      },
      { timeout: 10_000, interval: 100 },
    );
  });

  afterAll(async () => {
    await api.close();
    await redis.stop();
  });

  it('grava o estado com TTL de 24 h, isolado por tenant, e deduplica a prévia em andamento', async () => {
    const store = api.app.get(TemplatePreviewStore);
    const raw = api.app.get(RedisClient, { strict: false }).redis;
    const preview = requestTemplatePreview({
      renditionId: RENDITION,
      tenantId: A,
      templateVersionId: VERSION,
      templateVersionRevision: 5,
      requestedById: null,
      now: new Date(),
    });
    await asTenant(A, () => store.save(preview));

    const [key] = await raw.keys(`cf:*:t:${A}:template-preview:preview:${RENDITION}`);
    expect(key).toBeDefined();
    const ttl = await raw.ttl(key ?? '');
    expect(ttl).toBeGreaterThan(24 * 3600 - 60);
    expect(ttl).toBeLessThanOrEqual(24 * 3600);

    await expect(asTenant(A, () => store.find(RENDITION))).resolves.toMatchObject({
      status: 'PENDING',
      templateVersionId: VERSION,
    });
    await expect(asTenant(B, () => store.find(RENDITION))).resolves.toBeNull();

    const active = { templateVersionId: VERSION, revision: 5, userId: null };
    await expect(asTenant(A, () => store.claimActive(active, RENDITION))).resolves.toBe(true);
    await expect(asTenant(A, () => store.claimActive(active, OTHER))).resolves.toBe(false);
    await expect(asTenant(A, () => store.activeOf(active))).resolves.toBe(RENDITION);
    // Outro tenant, mesma chave relativa: trava independente.
    await expect(asTenant(B, () => store.claimActive(active, OTHER))).resolves.toBe(true);
    await asTenant(A, () => store.releaseActive(active, RENDITION));
    await expect(asTenant(A, () => store.activeOf(active))).resolves.toBeNull();
  });
});
