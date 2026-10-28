import { isIP } from 'node:net';

import { LOG_LEVELS, PRODUCTION_FORBIDDEN_LEVELS } from '@contrataflow/observability';
import type { LogLevel } from '@contrataflow/observability';
import {
  AI_MONTHLY_TOKEN_LIMIT_CEILING,
  AI_MONTHLY_TOKEN_LIMIT_MIN,
  AI_PLATFORM_MAX_MONTHLY_TOKENS_DEFAULT,
} from '@contrataflow/types';
import { AI_TERMS_CURRENT_VERSION } from '@contrataflow/validation';
import { z } from 'zod';

/** CIDR IPv4 (`10.0.0.0/8`) ou IPv6 (`fd00::/8`); IP sem prefixo vale como host único. */
export function isCidr(value: string): boolean {
  const [address = '', prefix, ...rest] = value.split('/');
  const family = isIP(address);
  if (family === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

const blankAsUndefined = (value: unknown) => (value === '' ? undefined : value);
const optionalUrl = z.preprocess(blankAsUndefined, z.url().optional());
const optionalText = z.preprocess(blankAsUndefined, z.string().trim().min(1).max(512).optional());
const booleanFlag = z.preprocess(
  blankAsUndefined,
  z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
);

/** Ambientes em que a identidade fake (FA-02) pode ser ligada. */
const FAKE_IDENTITY_ENVS: ReadonlySet<string> = new Set(['local', 'dev', 'test']);

/** Variáveis de ambiente da API (RN-FND-30 · architecture.md §10.1), antes das regras cruzadas. */
const envObject = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Ambiente lógico; compõe o prefixo das chaves Redis `cf:{env}:…` (multi-tenancy.md §7). */
  APP_ENV: z.enum(['local', 'dev', 'test', 'staging', 'production']).default('local'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  /**
   * Porta INTERNA de `/metrics` (HLT-03 · US-085), separada da pública — nunca atrás do ALB
   * público (V-03). Padrão 9464 (porta de referência do exportador Prometheus do OpenTelemetry).
   */
  METRICS_PORT: z.coerce.number().int().min(1).max(65_535).default(9464),
  /** Validade do resultado de `/health/ready` no processo (RN-FND-80 · FA-03). */
  HEALTH_CACHE_TTL_MS: z.coerce.number().int().positive().default(5_000),
  /** Timeout de cada *check*; ausente = 1 000 ms PostgreSQL e 500 ms Redis (observability.md §6.2). */
  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  /** Papel `cf_app` (multi-tenancy.md §5.2): sem BYPASSRLS e sem DDL (US-081 · RN-FND-46). */
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  /** Conexões por réplica (architecture.md §12.1). */
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  /**
   * Papel `cf_platform` do `SystemDbService` (US-100 · RN-TEN-28): sem BYPASSRLS, DML em `tenants`,
   * auditoria de plataforma e as funções entre tenants. Obrigatória fora de local/dev/test;
   * ausente (só nesses ambientes) → o `SystemDbService` recusa as chamadas.
   */
  DATABASE_URL_PLATFORM: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.url({ protocol: /^postgres(ql)?$/ }).optional(),
  ),
  REDIS_CACHE_URL: z.url({ protocol: /^rediss?$/ }),
  /**
   * Redis de sessões do BFF (DEC-131), lido só pela varredura de encerramentos de sessão
   * (US-088 · RN-IAM-28). Obrigatória fora de local/dev/test; ausente (só nesses ambientes) → a
   * varredura fica desligada e nenhum `auth.session_end`/`auth.session_expired` é gravado.
   */
  REDIS_SESSION_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.url({ protocol: /^rediss?$/ }).optional(),
  ),
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
  /*
   * Proteção de campos sensíveis (DEC-086 · US-025): chave mestra AES-256 (32 bytes em base64) que
   * cifra as chaves de dados do CPF e chave HMAC do *blind index* (≥ 32 bytes em base64).
   * Obrigatórias fora de local/dev/test (em produção, a chave mestra vem do KMS pelo Secrets
   * Manager); ausentes lá, usam-se chaves fixas de desenvolvimento — nunca com dados reais.
   */
  FIELD_ENCRYPTION_KEY: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .trim()
      .refine((value) => Buffer.from(value, 'base64').length === 32, 'Informe 32 bytes em base64.')
      .optional(),
  ),
  BLIND_INDEX_KEY: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .trim()
      .refine(
        (value) => Buffer.from(value, 'base64').length >= 32,
        'Informe ao menos 32 bytes em base64.',
      )
      .optional(),
  ),
  CORRELATION_HEADER_NAME: z.literal('X-Correlation-Id').default('X-Correlation-Id'),
  /**
   * Origens confiáveis de `X-Forwarded-For` e `X-CF-Session-Id-Hash` (o BFF — security.md §8),
   * CIDRs IPv4/IPv6 separados por vírgula. Ausente: o IP do socket vale como IP do cliente.
   */
  TRUSTED_PROXY_CIDRS: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .trim()
      .refine((value) => value.split(',').every((entry) => isCidr(entry.trim())), 'CIDR inválido.')
      .optional(),
  ),
  PAGINATION_MAX_PAGE_SIZE: z.coerce.number().int().min(1).max(100).default(100),
  RATE_LIMIT_READ_PER_MIN: z.coerce.number().int().positive().default(600),
  RATE_LIMIT_WRITE_PER_MIN: z.coerce.number().int().positive().default(120),
  IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().positive().default(24),
  /** Nível mínimo de log (RN-FND-72); `debug`/`trace` nunca em produção (V-03). */
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  /** `<versão>+g<commit>`, injetado no build (US-079). */
  APP_VERSION: z.string().trim().min(1).default('0.0.0+local'),
  /*
   * Auditoria (US-073 · RN-AUD-06/07): parâmetros de PLATAFORMA — nenhum tenant reduz a própria
   * trilha, e nenhuma variável desliga a gravação.
   */
  AUDIT_COALESCE_WINDOW_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
  AUDIT_COALESCE_MAX_REVISION_GAP: z.coerce.number().int().min(1).max(1_000).default(20),
  AUDIT_COALESCE_MAX_SIZE_VARIATION_PCT: z.coerce.number().min(1).max(1_000).default(30),
  AUDIT_ACCESS_DENIED_SAMPLING_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(3_600)
    .default(60),
  AUDIT_ACCESS_DENIED_SAMPLING_MAX_PER_WINDOW: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(20),
  /** `audit.sealVerification.maxPeriods` (US-074 · FA-04): selos por verificação (AUD-05). */
  AUDIT_SEAL_VERIFICATION_MAX_PERIODS: z.coerce.number().int().min(1).max(8_760).default(720),
  /** `audit.export.maxRows` (US-075 · RN-AUD-19): linhas por exportação (AUD-03). */
  AUDIT_EXPORT_MAX_ROWS: z.coerce.number().int().min(1).max(1_000_000).default(100_000),
  /*
   * IA (US-115 · RN-AI-14 · DEC-079): provedor e modelos são configuração de PLATAFORMA. `fake`
   * (padrão em local/dev/test) ou `none` (padrão nos demais: desliga para todos — 503). Os
   * provedores reais entram com o adaptador da ADR-013 (PEND-21); segredos no Secrets Manager.
   */
  AI_PROVIDER: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.enum(['fake', 'none', 'anthropic', 'bedrock', 'openai', 'azure-openai']).optional(),
  ),
  AI_MODEL_DRAFT: z.string().trim().min(1).max(100).default('fake-draft-1'),
  AI_MODEL_SECTION: z.string().trim().min(1).max(100).default('fake-section-1'),
  /** Timeout de cada chamada ao provedor (RN-AI-08: 120 s). */
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  /*
   * IA no órgão (US-116 · DEC-079): versão vigente dos termos de uso (texto versionado em
   * `@contrataflow/validation` — `AI_TERMS_DOCUMENTS`) e teto do `ai.monthlyTokenLimit` do tenant.
   */
  AI_TERMS_VERSION: z.string().trim().min(1).max(20).default(AI_TERMS_CURRENT_VERSION),
  AI_TENANT_MAX_MONTHLY_TOKENS: z.coerce
    .number()
    .int()
    .min(AI_MONTHLY_TOKEN_LIMIT_MIN)
    .max(AI_MONTHLY_TOKEN_LIMIT_CEILING)
    .default(AI_PLATFORM_MAX_MONTHLY_TOKENS_DEFAULT),
  /*
   * Storage S3/MinIO (US-068 · storage.md §2.2). Sem os buckets, o storage fica desligado e as
   * rotas de anexo respondem 503. `S3_PUBLIC_ENDPOINT` é o host que o NAVEGADOR alcança (assina as
   * URLs); `S3_ENDPOINT`, o da rede interna. Credenciais estáticas só fora de produção (task role).
   */
  S3_ENDPOINT: optionalUrl,
  S3_PUBLIC_ENDPOINT: optionalUrl,
  S3_REGION: z.string().trim().min(1).max(40).default('us-east-1'),
  S3_FORCE_PATH_STYLE: booleanFlag,
  S3_ACCESS_KEY_ID: optionalText,
  S3_SECRET_ACCESS_KEY: optionalText,
  S3_BUCKET_QUARANTINE: optionalText,
  S3_BUCKET_DOCUMENTS: optionalText,
  S3_BUCKET_RENDITIONS: optionalText,
  /** ClamAV (`clamd`, INSTREAM — storage.md §5.3); ausente = varredura pausada (RN-DOC-75). */
  CLAMAV_HOST: optionalText,
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65_535).default(3310),
  CLAMAV_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(60_000),
  /** Gotenberg (HTML → PDF, US-067 · ADR-007); ausente = renderização pausada (sem PDF). */
  GOTENBERG_URL: optionalUrl,
  GOTENBERG_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  /** Limite técnico de armazenamento por tenant (storage.md §8 · PEND-17 — proposta 50 GB). */
  STORAGE_TENANT_QUOTA_GB: z.coerce.number().int().min(1).max(100_000).default(50),
});

/**
 * Onde a configuração é usada: `http` = processo da API; `jobs` = contexto de jobs da API dentro do
 * worker (DEC-052 · `@contrataflow/api/jobs`), sem as variáveis só de HTTP.
 */
type ConfigTarget = 'http' | 'jobs';

/** Regras cruzadas entre variáveis; as só de HTTP não valem para o contexto de jobs. */
function refineEnv(target: ConfigTarget) {
  return (env: z.infer<typeof envObject>, context: z.RefinementCtx): void => {
    if (env.NODE_ENV === 'production' && PRODUCTION_FORBIDDEN_LEVELS.includes(env.LOG_LEVEL)) {
      context.addIssue({ code: 'custom', path: ['LOG_LEVEL'], message: 'Proibido em produção.' });
    }
    if (target === 'http' && env.OIDC_FAKE_SIGNING_KEY && !FAKE_IDENTITY_ENVS.has(env.APP_ENV)) {
      context.addIssue({
        code: 'custom',
        path: ['OIDC_FAKE_SIGNING_KEY'],
        message: 'Identidade fake proibida neste ambiente.',
      });
    }
    if (target === 'http' && !env.INTERNAL_SERVICE_TOKEN && !FAKE_IDENTITY_ENVS.has(env.APP_ENV)) {
      context.addIssue({
        code: 'custom',
        path: ['INTERNAL_SERVICE_TOKEN'],
        message: 'Obrigatória fora de local/dev/test.',
      });
    }
    if (!env.DATABASE_URL_PLATFORM && !FAKE_IDENTITY_ENVS.has(env.APP_ENV)) {
      context.addIssue({
        code: 'custom',
        path: ['DATABASE_URL_PLATFORM'],
        message: 'Obrigatória fora de local/dev/test.',
      });
    }
    if (env.AI_PROVIDER !== undefined && !['fake', 'none'].includes(env.AI_PROVIDER)) {
      context.addIssue({
        code: 'custom',
        path: ['AI_PROVIDER'],
        message:
          'Adaptador do provedor ainda não disponível (ADR-013 · PEND-21): use fake ou none.',
      });
    }
    if (env.AI_PROVIDER === 'fake' && env.APP_ENV === 'production') {
      context.addIssue({
        code: 'custom',
        path: ['AI_PROVIDER'],
        message: 'Provedor de IA de teste proibido em produção.',
      });
    }
    for (const key of ['FIELD_ENCRYPTION_KEY', 'BLIND_INDEX_KEY'] as const) {
      if (!env[key] && !FAKE_IDENTITY_ENVS.has(env.APP_ENV)) {
        context.addIssue({
          code: 'custom',
          path: [key],
          message: 'Obrigatória fora de local/dev/test.',
        });
      }
    }
    if (env.S3_ACCESS_KEY_ID && env.APP_ENV === 'production') {
      context.addIssue({
        code: 'custom',
        path: ['S3_ACCESS_KEY_ID'],
        message: 'Credencial estática proibida em produção: use a task role (storage.md §2.2).',
      });
    }
    if (target === 'http' && !env.REDIS_SESSION_URL && !FAKE_IDENTITY_ENVS.has(env.APP_ENV)) {
      context.addIssue({
        code: 'custom',
        path: ['REDIS_SESSION_URL'],
        message: 'Obrigatória fora de local/dev/test.',
      });
    }
  };
}

/**
 * Schema único das variáveis de ambiente da API (RN-FND-30 · architecture.md §10.1). Toda
 * variável lida pela aplicação está aqui; `process.env` não é lido fora de `src/config/**`.
 */
export const envSchema = envObject.superRefine(refineEnv('http'));

/**
 * Emissor fictício do contexto de jobs: nenhum token é verificado ali (o worker não tem rotas da
 * API); o `.invalid` (RFC 2606) nunca resolve.
 */
const JOBS_ISSUER_PLACEHOLDER = 'http://jobs.invalid/';

/**
 * Contexto de jobs (DEC-052): `OIDC_ISSUER_URL` deixa de ser obrigatória; as regras de
 * `INTERNAL_SERVICE_TOKEN` (rotas `/internal/*`), `REDIS_SESSION_URL` (varredura de sessões, que é
 * da API) e da identidade fake não se aplicam — `toAppConfig` desliga as duas últimas.
 */
const jobsEnvSchema = envObject
  .extend({ OIDC_ISSUER_URL: z.url().default(JOBS_ISSUER_PLACEHOLDER) })
  .superRefine(refineEnv('jobs'));

export type Env = z.infer<typeof envSchema>;

/** Classes de rate limit de api.md §1.6 (a de autenticação fica no BFF). */
export type RateLimitClass = 'read' | 'write' | 'autosave' | 'export' | 'upload' | 'ai';

/** Configuração tipada e imutável injetada pelo `ConfigModule` (token `APP_CONFIG`). */
export interface AppConfig {
  readonly nodeEnv: Env['NODE_ENV'];
  readonly appEnv: Env['APP_ENV'];
  readonly port: number;
  /** `/metrics` na porta interna (HLT-03 · US-085). */
  readonly metrics: { readonly port: number };
  /** `/health/ready` (HLT-02 · US-085). */
  readonly health: {
    readonly cacheTtlMs: number;
    /** `null` = timeout padrão de cada dependência (1 s PostgreSQL, 500 ms Redis). */
    readonly checkTimeoutMs: number | null;
  };
  readonly database: {
    readonly url: string;
    readonly poolSize: number;
    /** Papel `cf_platform` do `SystemDbService` (US-100); `null` = chamadas recusadas. */
    readonly platformUrl: string | null;
    /** Espera máxima por uma conexão do pool ao abrir a transação. */
    readonly maxWaitMs: number;
    /** Duração máxima de uma transação (architecture.md §6.5). */
    readonly transactionTimeoutMs: number;
    /** `statement_timeout` de cada instrução, definido por transação. */
    readonly statementTimeoutMs: number;
  };
  readonly redis: {
    readonly cacheUrl: string;
    /** Redis de sessões do BFF (US-088); `null` = varredura de encerramentos desligada. */
    readonly sessionUrl: string | null;
  };
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
  /** Chaves em base64 da proteção de campos sensíveis (US-025); nulo = chave fixa de desenvolvimento. */
  readonly fieldProtection: {
    readonly encryptionKey: string | null;
    readonly blindIndexKey: string | null;
  };
  readonly http: {
    readonly correlationHeader: string;
    /** CIDRs de onde `X-Forwarded-For`/`X-CF-Session-Id-Hash` são aceitos (vazio = nenhum). */
    readonly trustedProxies: readonly string[];
  };
  readonly pagination: { readonly maxPageSize: number };
  readonly rateLimit: {
    readonly windowMs: number;
    readonly perClass: Readonly<Record<RateLimitClass, number>>;
    readonly perTenant: number;
  };
  readonly idempotency: { readonly ttlMs: number };
  readonly observability: { readonly logLevel: LogLevel; readonly version: string };
  /** Parâmetros de plataforma da auditoria (US-073); a gravação em si não é configurável. */
  readonly audit: {
    readonly coalesce: {
      readonly windowMs: number;
      readonly maxRevisionGap: number;
      readonly maxSizeVariationPct: number;
    };
    readonly accessDeniedSampling: {
      readonly windowSeconds: number;
      readonly maxPerWindow: number;
    };
    /** Meses de folga das partições mensais de `audit_logs` (job diário — FA-03). */
    readonly partitionMonthsAhead: number;
    /** Teto de selos recalculados por verificação (AUD-05 · US-074 FA-04). */
    readonly sealVerificationMaxPeriods: number;
    /** Teto de linhas por exportação (AUD-03 · US-075 RN-AUD-19) — acima, 422 `EXPORT_TOO_LARGE`. */
    readonly exportMaxRows: number;
  };
  /** Camada de IA (US-115 · RN-AI-14): provedor de plataforma, modelos e timeout. */
  readonly ai: {
    readonly provider: 'fake' | 'none';
    readonly models: { readonly draft: string; readonly section: string };
    readonly requestTimeoutMs: number;
    /** Versão vigente dos termos de uso (`AI_TERMS_VERSION` — US-116). */
    readonly termsVersion: string;
    /** Teto do limite mensal de tokens por tenant (`AI_TENANT_MAX_MONTHLY_TOKENS`). */
    readonly tenantMaxMonthlyTokens: number;
  };
  /** Storage de objetos (US-068 · storage.md §2.2); `s3: null` = desligado (rotas → 503). */
  readonly storage: {
    readonly s3: S3Config | null;
    /** Limite técnico por tenant (storage.md §8 · PEND-17), em bytes. */
    readonly tenantQuotaBytes: number;
  };
  /** `clamd` (US-068); `null` = varredura pausada até a configuração (nunca libera — P3). */
  readonly antivirus: {
    readonly host: string;
    readonly port: number;
    readonly timeoutMs: number;
  } | null;
  /** Gotenberg (US-067); `null` = `document-render` pausado até a configuração. */
  readonly pdf: {
    readonly gotenbergUrl: string;
    readonly timeoutMs: number;
  } | null;
}

export interface S3Config {
  /** Endpoint interno (MinIO em dev); `null` = endpoint padrão da AWS. */
  readonly endpoint: string | null;
  /** Host das URLs pré-assinadas entregues ao navegador; `null` = o interno. */
  readonly publicEndpoint: string | null;
  readonly region: string;
  readonly forcePathStyle: boolean;
  /** `null` = cadeia padrão de credenciais (task role no ECS). */
  readonly credentials: { readonly accessKeyId: string; readonly secretAccessKey: string } | null;
  readonly buckets: {
    readonly quarantine: string;
    readonly documents: string;
    readonly renditions: string;
  };
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
    metrics: { port: env.METRICS_PORT },
    health: {
      cacheTtlMs: env.HEALTH_CACHE_TTL_MS,
      checkTimeoutMs: env.HEALTH_CHECK_TIMEOUT_MS ?? null,
    },
    database: {
      url: env.DATABASE_URL,
      poolSize: env.DATABASE_POOL_SIZE,
      platformUrl: env.DATABASE_URL_PLATFORM ?? null,
      maxWaitMs: 2_000,
      transactionTimeoutMs: 10_000,
      statementTimeoutMs: 5_000,
    },
    redis: { cacheUrl: env.REDIS_CACHE_URL, sessionUrl: env.REDIS_SESSION_URL ?? null },
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
    fieldProtection: {
      encryptionKey: env.FIELD_ENCRYPTION_KEY ?? null,
      blindIndexKey: env.BLIND_INDEX_KEY ?? null,
    },
    http: {
      correlationHeader: env.CORRELATION_HEADER_NAME,
      trustedProxies: (env.TRUSTED_PROXY_CIDRS ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    },
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
        // "Geração com IA" (AI-01): 10 req/min por usuário + tenant.
        ai: 10,
      },
      perTenant: 6_000,
    },
    idempotency: { ttlMs: env.IDEMPOTENCY_TTL_HOURS * 3_600_000 },
    observability: { logLevel: env.LOG_LEVEL, version: env.APP_VERSION },
    audit: {
      coalesce: {
        windowMs: env.AUDIT_COALESCE_WINDOW_MINUTES * 60_000,
        maxRevisionGap: env.AUDIT_COALESCE_MAX_REVISION_GAP,
        maxSizeVariationPct: env.AUDIT_COALESCE_MAX_SIZE_VARIATION_PCT,
      },
      accessDeniedSampling: {
        windowSeconds: env.AUDIT_ACCESS_DENIED_SAMPLING_WINDOW_SECONDS,
        maxPerWindow: env.AUDIT_ACCESS_DENIED_SAMPLING_MAX_PER_WINDOW,
      },
      partitionMonthsAhead: 2,
      sealVerificationMaxPeriods: env.AUDIT_SEAL_VERIFICATION_MAX_PERIODS,
      exportMaxRows: env.AUDIT_EXPORT_MAX_ROWS,
    },
    ai: {
      provider:
        env.AI_PROVIDER === 'fake' || env.AI_PROVIDER === 'none'
          ? env.AI_PROVIDER
          : FAKE_IDENTITY_ENVS.has(env.APP_ENV)
            ? 'fake'
            : 'none',
      models: { draft: env.AI_MODEL_DRAFT, section: env.AI_MODEL_SECTION },
      requestTimeoutMs: env.AI_REQUEST_TIMEOUT_MS,
      termsVersion: env.AI_TERMS_VERSION,
      tenantMaxMonthlyTokens: env.AI_TENANT_MAX_MONTHLY_TOKENS,
    },
    storage: {
      s3: s3ConfigOf(env),
      tenantQuotaBytes: env.STORAGE_TENANT_QUOTA_GB * 1024 ** 3,
    },
    antivirus:
      env.CLAMAV_HOST === undefined
        ? null
        : { host: env.CLAMAV_HOST, port: env.CLAMAV_PORT, timeoutMs: env.CLAMAV_TIMEOUT_MS },
    pdf:
      env.GOTENBERG_URL === undefined
        ? null
        : { gotenbergUrl: env.GOTENBERG_URL, timeoutMs: env.GOTENBERG_TIMEOUT_MS },
  };
}

function s3ConfigOf(env: Env): S3Config | null {
  const { S3_BUCKET_QUARANTINE, S3_BUCKET_DOCUMENTS, S3_BUCKET_RENDITIONS } = env;
  if (!S3_BUCKET_QUARANTINE || !S3_BUCKET_DOCUMENTS || !S3_BUCKET_RENDITIONS) return null;
  return {
    endpoint: env.S3_ENDPOINT ?? null,
    publicEndpoint: env.S3_PUBLIC_ENDPOINT ?? null,
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials:
      env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
        ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }
        : null,
    buckets: {
      quarantine: S3_BUCKET_QUARANTINE,
      documents: S3_BUCKET_DOCUMENTS,
      renditions: S3_BUCKET_RENDITIONS,
    },
  };
}

/** Valida o ambiente e devolve a configuração congelada (falha rápida no bootstrap). */
export function loadConfig(source: Readonly<Record<string, string | undefined>>): AppConfig {
  return deepFreeze(toAppConfig(parseEnv(envSchema, source)));
}

/**
 * Configuração do contexto de jobs da API no worker (DEC-052 · `@contrataflow/api/jobs`): o mesmo
 * `.env`, sem exigir as variáveis só de HTTP. A identidade fake (repositórios em memória) e o Redis
 * de sessões ficam desligados: o worker sempre persiste no banco e a varredura de sessões é da API.
 */
export function loadJobsConfig(source: Readonly<Record<string, string | undefined>>): AppConfig {
  const config = toAppConfig(parseEnv(jobsEnvSchema, source));
  return deepFreeze({
    ...config,
    redis: { ...config.redis, sessionUrl: null },
    oidc: { ...config.oidc, fakeSigningKey: null },
  });
}

function parseEnv(
  schema: z.ZodType<Env>,
  source: Readonly<Record<string, string | undefined>>,
): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const keys = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))].sort();
    throw new ConfigValidationError(keys);
  }
  return parsed.data;
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
