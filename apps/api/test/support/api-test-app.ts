import type { Server } from 'node:http';

import type { Logger as PinoLogger } from '@contrataflow/observability';
import type { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger as NestPinoLogger } from 'nestjs-pino';
import { __resetOutOfContextForTests } from 'nestjs-pino/PinoLogger.js';

import { loadConfig } from '#config/env.js';
import type { AppConfig } from '#config/env.js';
import type {
  FakeJwksProvider,
  FakeTokenClaims,
} from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { TOKEN_VERIFIER } from '#shared/auth/ports.js';
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
}

export interface TestApi {
  readonly app: INestApplication;
  readonly server: Server;
  readonly config: AppConfig;
  readonly rateLimitStore: InMemoryRateLimitStore;
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
      .useValue(new InMemoryIdempotencyStore());
  }
  for (const { token, value } of options.providers ?? []) {
    builder = builder.overrideProvider(token).useValue(value);
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
    bearer: (subject, claims = {}) => `Bearer ${verifier.sign({ sub: subject, ...claims })}`,
    close: () => app.close(),
  };
}
