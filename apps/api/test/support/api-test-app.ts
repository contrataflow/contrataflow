import type { Server } from 'node:http';

import type { Logger as PinoLogger } from '@contrataflow/observability';
import type { INestApplication, InjectionToken, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger as NestPinoLogger } from 'nestjs-pino';
import { __resetOutOfContextForTests } from 'nestjs-pino/PinoLogger.js';

import { loadConfig } from '#config/env.js';
import type { AppConfig } from '#config/env.js';
import { AUDIT_LOG_STORE } from '#modules/audit/application/ports.js';
import type { SealedAuditRecord } from '#modules/audit/domain/audit-record.js';
import { InMemoryAuditLogStore } from '#modules/audit/infrastructure/in-memory-audit.store.js';
import type {
  FakeJwksProvider,
  FakeTokenClaims,
} from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { OUTBOX_STORE } from '#modules/platform/application/outbox-ports.js';
import { InMemoryOutboxStore } from '#modules/platform/infrastructure/outbox/in-memory-outbox.store.js';
import type { InMemoryOutboxRow } from '#modules/platform/infrastructure/outbox/in-memory-outbox.store.js';
import {
  DRAFT_AUDIT_WINDOW_STORE,
  InMemoryDraftAuditWindowStore,
} from '#shared/audit/draft-audit.js';
import { AUDIT_SAMPLING_STORE, InMemoryAuditSamplingStore } from '#shared/audit/sampling-store.js';
import { TOKEN_VERIFIER } from '#shared/auth/ports.js';
import { CACHE_STORE, InMemoryCacheStore } from '#shared/cache/cache-store.js';
import { IDEMPOTENCY_STORE } from '#shared/idempotency/idempotency.js';
import { InMemoryIdempotencyStore } from '#shared/idempotency/in-memory-idempotency.store.js';
import { InMemoryRateLimitStore } from '#shared/rate-limit/in-memory-rate-limit.store.js';
import { RATE_LIMIT_STORE } from '#shared/rate-limit/rate-limit.js';

import { AppModule } from '../../src/app.module.js';
import { configureApiApp } from '../../src/bootstrap.js';

/** Chave HS256 de teste do `FakeJwksProvider` (nunca usada fora dos testes). */
export const TEST_SIGNING_KEY = 'contrataflow-test-only-signing-key-0000';
/** Credencial de serviço do BFF nas rotas `/internal/*` (US-087), só nos testes. */
export const TEST_SERVICE_TOKEN = 'contrataflow-test-only-service-token-000';
export const TEST_ISSUER = 'https://issuer.contrataflow.test/application/o/contrataflow/';

/** Configuração de teste; por padrão o Redis aponta para uma porta fechada (falha imediata). */
export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    APP_ENV: 'test',
    // Porta fechada: nenhuma rota do pipeline abre transação; o pool conecta sob demanda.
    DATABASE_URL: 'postgresql://cf_app:test@127.0.0.1:1/contrataflow',
    REDIS_CACHE_URL: 'redis://127.0.0.1:1',
    OIDC_ISSUER_URL: TEST_ISSUER,
    OIDC_FAKE_SIGNING_KEY: TEST_SIGNING_KEY,
    INTERNAL_SERVICE_TOKEN: TEST_SERVICE_TOKEN,
    ...overrides,
  });
}

export interface TestApiOptions {
  readonly config?: AppConfig;
  /** `memory` (padrão): armazenamentos em memória; `redis`: os adaptadores Redis reais. */
  readonly stores?: 'memory' | 'redis';
  /** Controllers extras só para o teste (ex.: handler lento). */
  readonly controllers?: Type[];
  /** Logger pino que recebe os logs da aplicação (padrão: Nest silenciado). */
  readonly logger?: PinoLogger;
  /** Substitui providers pelo token (ex.: diretório do Authentik, relógio). */
  readonly providers?: readonly { readonly token: unknown; readonly value: unknown }[];
  /** Substitui providers pelo token por outro provider da aplicação (ex.: o adaptador real). */
  readonly aliases?: readonly { readonly token: unknown; readonly existing: InjectionToken }[];
}

export interface TestApi {
  readonly app: INestApplication;
  readonly server: Server;
  readonly config: AppConfig;
  readonly rateLimitStore: InMemoryRateLimitStore;
  /** Registros de auditoria gravados (modo em memória — identidade fake sem banco). */
  auditRecords(): readonly SealedAuditRecord[];
  /** Eventos gravados no outbox (modo em memória): `PENDING` até um relay publicá-los. */
  outboxRows(): readonly InMemoryOutboxRow[];
  /** `Authorization: Bearer …` válido para o `sub` informado (claims extras opcionais). */
  bearer(subject: string, claims?: Partial<FakeTokenClaims>): string;
  close(): Promise<void>;
}

export async function createTestApi(options: TestApiOptions = {}): Promise<TestApi> {
  const config = options.config ?? testConfig();
  // O nestjs-pino guarda o logger de fora de requisição no primeiro uso do processo.
  if (options.logger) __resetOutOfContextForTests();
  const rateLimitStore = new InMemoryRateLimitStore();
  let builder = Test.createTestingModule({
    imports: [AppModule.forRoot(config, options.logger ? { logger: options.logger } : {})],
    controllers: options.controllers ?? [],
  });
  if ((options.stores ?? 'memory') === 'memory') {
    builder = builder
      .overrideProvider(RATE_LIMIT_STORE)
      .useValue(rateLimitStore)
      .overrideProvider(IDEMPOTENCY_STORE)
      .useValue(new InMemoryIdempotencyStore())
      .overrideProvider(AUDIT_SAMPLING_STORE)
      .useValue(new InMemoryAuditSamplingStore())
      .overrideProvider(DRAFT_AUDIT_WINDOW_STORE)
      .useValue(new InMemoryDraftAuditWindowStore())
      .overrideProvider(CACHE_STORE)
      .useValue(new InMemoryCacheStore());
  }
  for (const { token, value } of options.providers ?? []) {
    builder = builder.overrideProvider(token).useValue(value);
  }
  for (const { token, existing } of options.aliases ?? []) {
    builder = builder
      .overrideProvider(token)
      .useFactory({ factory: (provider: unknown) => provider, inject: [existing] });
  }
  const moduleRef = await builder.compile();
  const app = configureApiApp(
    moduleRef.createNestApplication({ bodyParser: false, logger: false }),
  );
  if (options.logger) app.useLogger(app.get(NestPinoLogger));
  // Já escutando: o supertest reutiliza o servidor em vez de abrir uma porta por requisição.
  await app.listen(0, '127.0.0.1');
  const verifier = app.get<FakeJwksProvider>(TOKEN_VERIFIER);

  return {
    app,
    server: app.getHttpServer() as Server,
    config,
    rateLimitStore,
    auditRecords: () => {
      const store = app.get<unknown>(AUDIT_LOG_STORE);
      return store instanceof InMemoryAuditLogStore ? store.records : [];
    },
    outboxRows: () => {
      const store = app.get<unknown>(OUTBOX_STORE, { strict: false });
      return store instanceof InMemoryOutboxStore ? store.rows : [];
    },
    bearer: (subject, claims = {}) => `Bearer ${verifier.sign({ sub: subject, ...claims })}`,
    close: () => app.close(),
  };
}
