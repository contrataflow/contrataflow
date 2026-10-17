import { createHash } from 'node:crypto';

import { Global, Module } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { AI_CIRCUIT_STORE } from '#shared/ai/ai-circuit-store.js';
import { AUDIT_SAMPLING_STORE } from '#shared/audit/sampling-store.js';
import { CACHE_STORE } from '#shared/cache/cache-store.js';
import { PlatformCache, TenantCache } from '#shared/cache/tenant-cache.js';
import {
  EnvelopeFieldProtection,
  FIELD_PROTECTION,
  LocalKeyWrapper,
} from '#shared/crypto/field-protection.js';
import { IDEMPOTENCY_STORE } from '#shared/idempotency/idempotency.js';
import { JOB_QUEUE } from '#shared/jobs/job-queue.js';
import { OUTBOX_WRITER, SYNC_EVENT_HANDLERS } from '#shared/outbox/outbox-writer.js';
import { RATE_LIMIT_STORE } from '#shared/rate-limit/rate-limit.js';
import { DisabledSessionRegistry, SESSION_REGISTRY } from '#shared/sessions/session-registry.js';
import {
  OBJECT_STORAGE,
  StorageService,
  UnconfiguredObjectStorage,
} from '#shared/storage/storage.service.js';

import { OUTBOX_STORE } from './application/outbox-ports.js';
import { OutboxWriterService } from './application/outbox-writer.service.js';
import { PlatformFacade } from './application/platform.facade.js';
import { SyncEventHandlerRegistry } from './application/sync-event-handler.registry.js';
import { InMemoryOutboxStore } from './infrastructure/outbox/in-memory-outbox.store.js';
import { PrismaOutboxStore } from './infrastructure/outbox/prisma-outbox.store.js';
import { BullJobQueue } from './infrastructure/queues/bull-job-queue.js';
import { InMemoryJobQueue } from './infrastructure/queues/in-memory-job-queue.js';
import { InMemoryAiCircuitStore } from './infrastructure/redis/in-memory-ai-circuit.store.js';
import { RedisAiCircuitStore } from './infrastructure/redis/redis-ai-circuit.store.js';
import { RedisAuditSamplingStore } from './infrastructure/redis/redis-audit-sampling.store.js';
import { RedisCacheStore } from './infrastructure/redis/redis-cache.store.js';
import { RedisHealthIndicator } from './infrastructure/redis/redis-health.indicator.js';
import { RedisIdempotencyStore } from './infrastructure/redis/redis-idempotency.store.js';
import { RedisSessionRegistry } from './infrastructure/redis/redis-session-registry.js';
import { RedisThrottlerStorage } from './infrastructure/redis/redis-throttler.storage.js';
import { RedisClient } from './infrastructure/redis/redis.client.js';
import { InternalExampleController } from './presentation/internal-example.controller.js';

/** Chave fixa de desenvolvimento (local/dev/test sem as variáveis de ambiente) — nunca com dados reais. */
function developmentKey(label: string): Buffer {
  return createHash('sha256').update(`contrataflow:dev-only:${label}`).digest();
}

/**
 * Módulo `platform` (DEC-040, nível 0): outros módulos usam somente a fachada exportada. Fornece
 * os armazenamentos Redis do rate limit e da idempotência ao pipeline HTTP, os contadores da
 * amostragem de `access.denied` à auditoria (US-073), a rota interna de exemplo da US-080, o
 * outbox transacional (US-082) e o acesso da varredura de sessões ao Redis de sessões do BFF
 * (`SESSION_REGISTRY`, US-088 — desligado sem `REDIS_SESSION_URL`). É GLOBAL porque todo módulo
 * que produz fato de domínio injeta a porta `OUTBOX_WRITER` (e os donos das projeções síncronas,
 * `SYNC_EVENT_HANDLERS`) do shared kernel, sem importar este módulo (DEC-072). Desde a US-100
 * também fornece o cache isolado por tenant (`TenantCache`/`PlatformCache` sobre `CACHE_STORE`) e o
 * `StorageService` com a guarda de prefixo `tenants/{tenantId}/` (adaptador S3 na US-068). Desde a
 * US-115, o produtor de jobs do padrão B da API (`JOB_QUEUE`, BullMQ) e o estado de plataforma do
 * disjuntor do provedor de IA (`AI_CIRCUIT_STORE`, chave `cf:{env}:ai:circuit`).
 */
@Global()
@Module({
  controllers: [InternalExampleController],
  providers: [
    PlatformFacade,
    RedisClient,
    RedisHealthIndicator,
    { provide: RATE_LIMIT_STORE, useClass: RedisThrottlerStorage },
    { provide: IDEMPOTENCY_STORE, useClass: RedisIdempotencyStore },
    { provide: AUDIT_SAMPLING_STORE, useClass: RedisAuditSamplingStore },
    { provide: CACHE_STORE, useClass: RedisCacheStore },
    TenantCache,
    PlatformCache,
    {
      // US-025 · DEC-086: criptografia de campos (CPF) com envelope + blind index. Produção troca o
      // `LocalKeyWrapper` pelo adaptador do KMS (mesma porta `KeyWrapper`).
      provide: FIELD_PROTECTION,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new EnvelopeFieldProtection(
          new LocalKeyWrapper(
            config.fieldProtection.encryptionKey === null
              ? developmentKey('field-encryption')
              : Buffer.from(config.fieldProtection.encryptionKey, 'base64'),
          ),
          config.fieldProtection.blindIndexKey === null
            ? developmentKey('blind-index')
            : Buffer.from(config.fieldProtection.blindIndexKey, 'base64'),
        ),
    },
    // Adaptador S3/MinIO da US-068; até lá, a guarda de tenant funciona e o adaptador recusa.
    { provide: OBJECT_STORAGE, useClass: UnconfiguredObjectStorage },
    StorageService,
    {
      provide: SESSION_REGISTRY,
      inject: [APP_CONFIG],
      // Conexão própria com o Redis de sessões; sem a URL (só local/dev/test) a varredura não roda.
      useFactory: (config: AppConfig) =>
        config.redis.sessionUrl === null
          ? new DisabledSessionRegistry()
          : new RedisSessionRegistry(config.redis.sessionUrl, config.appEnv),
    },
    PrismaOutboxStore,
    {
      provide: OUTBOX_STORE,
      inject: [APP_CONFIG, PrismaOutboxStore],
      // Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): outbox em memória.
      useFactory: (config: AppConfig, prisma: PrismaOutboxStore) =>
        config.oidc.fakeSigningKey === null ? prisma : new InMemoryOutboxStore(),
    },
    SyncEventHandlerRegistry,
    { provide: SYNC_EVENT_HANDLERS, useExisting: SyncEventHandlerRegistry },
    OutboxWriterService,
    { provide: OUTBOX_WRITER, useExisting: OutboxWriterService },
    // US-115: produtor de jobs do padrão B (DEC-163) e disjuntor do provedor de IA (DEC-079).
    BullJobQueue,
    {
      provide: JOB_QUEUE,
      inject: [APP_CONFIG, BullJobQueue],
      useFactory: (config: AppConfig, bull: BullJobQueue) =>
        config.oidc.fakeSigningKey === null ? bull : new InMemoryJobQueue(),
    },
    RedisAiCircuitStore,
    {
      provide: AI_CIRCUIT_STORE,
      inject: [APP_CONFIG, RedisAiCircuitStore],
      useFactory: (config: AppConfig, redis: RedisAiCircuitStore) =>
        config.oidc.fakeSigningKey === null ? redis : new InMemoryAiCircuitStore(),
    },
  ],
  exports: [
    PlatformFacade,
    RATE_LIMIT_STORE,
    IDEMPOTENCY_STORE,
    AUDIT_SAMPLING_STORE,
    CACHE_STORE,
    TenantCache,
    PlatformCache,
    FIELD_PROTECTION,
    StorageService,
    SESSION_REGISTRY,
    OUTBOX_WRITER,
    SYNC_EVENT_HANDLERS,
    JOB_QUEUE,
    AI_CIRCUIT_STORE,
  ],
})
export class PlatformModule {}
