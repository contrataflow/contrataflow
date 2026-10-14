import { z } from 'zod';

/*
 * Configuração do web/BFF (architecture.md §10 · 12-factor): único lugar que lê `process.env`.
 * Validada com Zod; a falha lista só as chaves (nunca valores). Segredos não têm padrão.
 */

/** Variáveis expostas ao browser — lista fechada e sem segredo (V-04 · architecture.md §8.3). */
export const PUBLIC_ENV_ALLOWLIST = ['NEXT_PUBLIC_APP_NAME'] as const;

export type EnvSource = Readonly<Record<string, string | undefined>>;

export class WebConfigError extends Error {
  constructor(readonly keys: readonly string[]) {
    super(`Configuração inválida do web: ${keys.join(', ')}.`);
    this.name = 'WebConfigError';
  }
}

/** Falha (no build e no boot) se existir `NEXT_PUBLIC_*` fora da lista fechada (V-04). */
export function assertPublicEnv(env: EnvSource): void {
  const allowed: readonly string[] = PUBLIC_ENV_ALLOWLIST;
  const offending = Object.keys(env)
    .filter((key) => key.startsWith('NEXT_PUBLIC_') && !allowed.includes(key))
    .sort();
  if (offending.length > 0) {
    throw new WebConfigError(offending.map((key) => `${key} (fora da lista NEXT_PUBLIC_*)`));
  }
}

const IPV4_CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

export interface Ipv4Cidr {
  readonly network: number;
  readonly prefix: number;
}

/** `a.b.c.d/n` → rede e prefixo; `null` se inválido. */
export function parseCidr(value: string): Ipv4Cidr | null {
  const match = IPV4_CIDR.exec(value.trim());
  if (!match) return null;
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (octets.some((octet) => octet > 255) || prefix > 32) return null;
  const network = octets.reduce((acc, octet) => acc * 256 + octet, 0);
  return { network, prefix };
}

const cidrList = z
  .string()
  .trim()
  .min(1)
  .transform((value, context) => {
    const parsed = value.split(',').map((entry) => parseCidr(entry));
    if (parsed.some((entry) => entry === null)) {
      context.addIssue({ code: 'custom', message: 'CIDR inválido.' });
      return z.NEVER;
    }
    return parsed as Ipv4Cidr[];
  });

const optionalText = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === '' ? undefined : value));

/** Ambientes em que o provedor de identidade fake (FA-06) pode ser ligado. */
const FAKE_IDENTITY_ENVS = new Set(['local', 'dev', 'test']);

const envSchema = z
  .object({
    APP_ENV: z.enum(['local', 'dev', 'test', 'staging', 'production']).default('local'),
    APP_BASE_URL: z.url(),
    API_INTERNAL_URL: z.url(),
    SESSION_COOKIE_NAME: z
      .string()
      .regex(/^__Host-[A-Za-z0-9_-]+$/)
      .default('__Host-cf_session'),
    CSP_REPORT_URI: z.string().startsWith('/').default('/api/csp-report'),
    TRUSTED_PROXY_CIDRS: cidrList,
    OIDC_ISSUER_URL: z.url(),
    /** `aud` dos tokens emitidos pelo provedor fake (o mesmo que a API aceita). */
    OIDC_AUDIENCE: z.string().trim().min(1).default('contrataflow-web'),
    /** Liga o provedor de identidade fake (FA-06) até o OIDC real da US-087. */
    OIDC_FAKE_SIGNING_KEY: z.string().min(32).optional(),
    S3_PUBLIC_ENDPOINT: optionalText,
    S3_BUCKET_QUARANTINE: optionalText,
    S3_BUCKET_RENDITIONS: optionalText,
  })
  .superRefine((env, context) => {
    if (env.OIDC_FAKE_SIGNING_KEY && !FAKE_IDENTITY_ENVS.has(env.APP_ENV)) {
      context.addIssue({
        code: 'custom',
        path: ['OIDC_FAKE_SIGNING_KEY'],
        message: 'Provedor fake proibido neste ambiente.',
      });
    }
  });

export interface WebConfig {
  readonly appEnv: z.infer<typeof envSchema>['APP_ENV'];
  /** Origem pública (`scheme://host[:port]`), usada em CSRF e redirecionamentos. */
  readonly appOrigin: string;
  readonly secure: boolean;
  readonly apiInternalUrl: string;
  readonly sessionCookieName: string;
  readonly cspReportUri: string;
  readonly trustedProxies: readonly Ipv4Cidr[];
  readonly oidc: {
    readonly issuerUrl: string;
    readonly audience: string;
    readonly fakeSigningKey: string | null;
  };
  /** Origens extras de `connect-src` (buckets S3 — security.md §8). */
  readonly connectSources: readonly string[];
  /** Origens extras de `form-action` (Authentik — security.md §8). */
  readonly formActionSources: readonly string[];
}

function bucketOrigin(endpoint: string | undefined, bucket: string | undefined): string | null {
  if (!endpoint || !bucket) return null;
  try {
    return new URL(endpoint).origin;
  } catch {
    return null;
  }
}

/** Valida e normaliza; lança `WebConfigError` com as chaves inválidas. */
export function loadWebConfig(env: EnvSource): WebConfig {
  assertPublicEnv(env);
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const keys = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))].sort();
    throw new WebConfigError(keys);
  }
  const data = parsed.data;
  const appUrl = new URL(data.APP_BASE_URL);
  const connectSources = [
    bucketOrigin(data.S3_PUBLIC_ENDPOINT, data.S3_BUCKET_QUARANTINE),
    bucketOrigin(data.S3_PUBLIC_ENDPOINT, data.S3_BUCKET_RENDITIONS),
  ].filter((origin): origin is string => origin !== null);
  return {
    appEnv: data.APP_ENV,
    appOrigin: appUrl.origin,
    secure: appUrl.protocol === 'https:',
    apiInternalUrl: data.API_INTERNAL_URL.replace(/\/+$/, ''),
    sessionCookieName: data.SESSION_COOKIE_NAME,
    cspReportUri: data.CSP_REPORT_URI,
    trustedProxies: data.TRUSTED_PROXY_CIDRS,
    oidc: {
      issuerUrl: data.OIDC_ISSUER_URL,
      audience: data.OIDC_AUDIENCE.split(',')[0]?.trim() ?? data.OIDC_AUDIENCE,
      fakeSigningKey: data.OIDC_FAKE_SIGNING_KEY ?? null,
    },
    connectSources: [...new Set(connectSources)],
    formActionSources: [new URL(data.OIDC_ISSUER_URL).origin],
  };
}

let cached: WebConfig | undefined;

/** Configuração do processo (memoizada). */
export function webConfig(): WebConfig {
  cached ??= loadWebConfig(process.env);
  return cached;
}

/** Só para testes: descarta a configuração memoizada. */
export function resetWebConfigForTests(): void {
  cached = undefined;
}

/**
 * Fontes extras da CSP lidas sem exigir o restante da configuração: o `proxy.ts` aplica os
 * cabeçalhos de segurança em toda resposta, inclusive quando o BFF ainda não está configurado.
 */
export function cspSources(): Pick<
  WebConfig,
  'connectSources' | 'formActionSources' | 'cspReportUri' | 'secure'
> {
  try {
    return webConfig();
  } catch {
    return {
      connectSources: [],
      formActionSources: [],
      cspReportUri: '/api/csp-report',
      secure: false,
    };
  }
}

/** `development` (Next em modo dev exige `'unsafe-eval'` na CSP). */
export function isDevelopmentBuild(): boolean {
  return process.env.NODE_ENV === 'development';
}
