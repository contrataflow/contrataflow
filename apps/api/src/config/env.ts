import { LOG_LEVELS, PRODUCTION_FORBIDDEN_LEVELS } from '@contrataflow/observability';
import type { LogLevel } from '@contrataflow/observability';
import { z } from 'zod';

/** Ambientes em que a identidade fake (FA-02) pode ser ligada. */
const FAKE_IDENTITY_ENVS: ReadonlySet<string> = new Set(['local', 'dev', 'test']);

/**
 * Schema único das variáveis de ambiente da API (RN-FND-30 · architecture.md §10.1). Toda
 * variável lida pela aplicação está aqui; `process.env` não é lido fora de `src/config/**`.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    /** Ambiente lógico; compõe o prefixo das chaves Redis `cf:{env}:…` (multi-tenancy.md §7). */
    APP_ENV: z.enum(['local', 'dev', 'test', 'staging', 'production']).default('local'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    /** Papel `cf_app` (multi-tenancy.md §5.2): sem BYPASSRLS e sem DDL (US-081 · RN-FND-46). */
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    /** Conexões por réplica (architecture.md §12.1). */
    DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
    REDIS_CACHE_URL: z.url({ protocol: /^rediss?$/ }),
    OIDC_ISSUER_URL: z.url(),
    /** Uma ou mais audiências aceitas, separadas por vírgula. */
    OIDC_AUDIENCE: z.string().trim().min(1).default('contrataflow-api'),
    OIDC_CLOCK_TOLERANCE_SECONDS: z.coerce.number().int().min(0).max(60).default(30),
    /**
     * Modo de identidade fake (FA-02 da US-080 · FA-06 da US-086): chave HS256 do
     * `FakeJwksProvider` e diretório em memória, para testes e desenvolvimento sem Authentik. Só em
     * local/dev/test; ausente (padrão) → JWKS do Authentik e tabelas reais (US-087).
     */
    OIDC_FAKE_SIGNING_KEY: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(32).optional(),
    ),
    /**
     * Credencial de serviço do BFF nas rotas `/internal/*` (US-087): comparada em tempo constante
     * com `X-CF-Service-Token`. Obrigatória em staging/produção; ausente → rotas internas recusadas.
     */
    INTERNAL_SERVICE_TOKEN: z.string().min(32).optional(),
    /** API administrativa do Authentik (vínculo do `sub` no primeiro login — RN-IAM-06). */
    AUTHENTIK_API_URL: z.url().optional(),
    AUTHENTIK_API_TOKEN: z.string().min(16).optional(),
    CORRELATION_HEADER_NAME: z.literal('X-Correlation-Id').default('X-Correlation-Id'),
    PAGINATION_MAX_PAGE_SIZE: z.coerce.number().int().min(1).max(100).default(100),
    RATE_LIMIT_READ_PER_MIN: z.coerce.number().int().positive().default(600),
    RATE_LIMIT_WRITE_PER_MIN: z.coerce.number().int().positive().default(120),
    IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().positive().default(24),
    /** Nível mínimo de log (RN-FND-72); `debug`/`trace` nunca em produção (V-03). */
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    /** `<versão>+g<commit>`, injetado no build (US-079). */
    APP_VERSION: z.string().trim().min(1).default('0.0.0+local'),
  })
  .superRefine((env, context) => {
    if (env.NODE_ENV === 'production' && PRODUCTION_FORBIDDEN_LEVELS.includes(env.LOG_LEVEL)) {
      context.addIssue({ code: 'custom', path: ['LOG_LEVEL'], message: 'Proibido em produção.' });
    }
    if (env.OIDC_FAKE_SIGNING_KEY && !FAKE_IDENTITY_ENVS.has(env.APP_ENV)) {
      context.addIssue({
        code: 'custom',
        path: ['OIDC_FAKE_SIGNING_KEY'],
        message: 'Identidade fake proibida neste ambiente.',
      });
    }
    if (!env.INTERNAL_SERVICE_TOKEN && !FAKE_IDENTITY_ENVS.has(env.APP_ENV)) {
      context.addIssue({
        code: 'custom',
        path: ['INTERNAL_SERVICE_TOKEN'],
        message: 'Obrigatória fora de local/dev/test.',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Classes de rate limit de api.md §1.6 (a de autenticação fica no BFF). */
export type RateLimitClass = 'read' | 'write' | 'autosave' | 'export' | 'upload';

/** Configuração tipada e imutável injetada pelo `ConfigModule` (token `APP_CONFIG`). */
export interface AppConfig {
  readonly nodeEnv: Env['NODE_ENV'];
  readonly appEnv: Env['APP_ENV'];
  readonly port: number;
  readonly database: {
    readonly url: string;
    readonly poolSize: number;
    /** Espera máxima por uma conexão do pool ao abrir a transação. */
    readonly maxWaitMs: number;
    /** Duração máxima de uma transação (architecture.md §6.5). */
    readonly transactionTimeoutMs: number;
    /** `statement_timeout` de cada instrução, definido por transação. */
    readonly statementTimeoutMs: number;
  };
  readonly redis: { readonly cacheUrl: string };
  readonly oidc: {
    readonly issuerUrl: string;
    readonly audiences: readonly string[];
    readonly clockToleranceSeconds: number;
    readonly fakeSigningKey: string | null;
  };
  /** Rotas `/internal/*` (BFF → API): credencial de serviço; `null` = rotas recusadas. */
  readonly internal: { readonly serviceToken: string | null };
  /** API administrativa do Authentik; `null` = vínculo do `sub` só por e-mail verificado. */
  readonly authentik: { readonly apiUrl: string; readonly apiToken: string } | null;
  readonly http: { readonly correlationHeader: string };
  readonly pagination: { readonly maxPageSize: number };
  readonly rateLimit: {
    readonly windowMs: number;
    readonly perClass: Readonly<Record<RateLimitClass, number>>;
    readonly perTenant: number;
  };
  readonly idempotency: { readonly ttlMs: number };
  readonly observability: { readonly logLevel: LogLevel; readonly version: string };
}

/** Variável ausente ou inválida: o processo não sobe (V-01). Lista as chaves, nunca os valores. */
export class ConfigValidationError extends Error {
  constructor(readonly keys: readonly string[]) {
    super(`Configuração inválida — verifique as variáveis de ambiente: ${keys.join(', ')}.`);
    this.name = 'ConfigValidationError';
  }
}

function toAppConfig(env: Env): AppConfig {
  return {
    nodeEnv: env.NODE_ENV,
    appEnv: env.APP_ENV,
    port: env.PORT,
    database: {
      url: env.DATABASE_URL,
      poolSize: env.DATABASE_POOL_SIZE,
      maxWaitMs: 2_000,
      transactionTimeoutMs: 10_000,
      statementTimeoutMs: 5_000,
    },
    redis: { cacheUrl: env.REDIS_CACHE_URL },
    oidc: {
      issuerUrl: env.OIDC_ISSUER_URL,
      audiences: env.OIDC_AUDIENCE.split(',')
        .map((audience) => audience.trim())
        .filter(Boolean),
      clockToleranceSeconds: env.OIDC_CLOCK_TOLERANCE_SECONDS,
      fakeSigningKey: env.OIDC_FAKE_SIGNING_KEY ?? null,
    },
    internal: { serviceToken: env.INTERNAL_SERVICE_TOKEN ?? null },
    authentik:
      env.AUTHENTIK_API_URL && env.AUTHENTIK_API_TOKEN
        ? { apiUrl: env.AUTHENTIK_API_URL, apiToken: env.AUTHENTIK_API_TOKEN }
        : null,
    http: { correlationHeader: env.CORRELATION_HEADER_NAME },
    pagination: { maxPageSize: env.PAGINATION_MAX_PAGE_SIZE },
    rateLimit: {
      windowMs: 60_000,
      // Limites padrão de api.md §1.6; só leitura e escrita são configuráveis (story US-080).
      perClass: {
        read: env.RATE_LIMIT_READ_PER_MIN,
        write: env.RATE_LIMIT_WRITE_PER_MIN,
        autosave: 60,
        export: 20,
        upload: 60,
      },
      perTenant: 6_000,
    },
    idempotency: { ttlMs: env.IDEMPOTENCY_TTL_HOURS * 3_600_000 },
    observability: { logLevel: env.LOG_LEVEL, version: env.APP_VERSION },
  };
}

/** Valida o ambiente e devolve a configuração congelada (falha rápida no bootstrap). */
export function loadConfig(source: Readonly<Record<string, string | undefined>>): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const keys = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))].sort();
    throw new ConfigValidationError(keys);
  }
  return deepFreeze(toAppConfig(parsed.data));
}

/** Lê `process.env` — único ponto da API autorizado a fazê-lo (RN-FND-06). */
export function loadConfigFromProcess(): AppConfig {
  return loadConfig(process.env);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
