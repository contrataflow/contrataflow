import 'server-only';

import { webConfig } from '@/config/env';
import type { WebConfig } from '@/config/env';

import { ApiSessionDirectory } from './auth/api-session-directory';
import { OidcIdentityProvider } from './auth/oidc-provider';
import { AuthentikPasswordRecovery, FakePasswordRecovery } from './auth/password-recovery';
import type { PasswordRecovery } from './auth/password-recovery';
import { AuthRateLimiter, MemoryRateLimitCounter, RedisRateLimitCounter } from './auth/rate-limit';
import type { RateLimitCounter } from './auth/rate-limit';
import { deriveKey, masterKey } from './crypto';
import { log } from './logger';
import { FakeIdentityProvider, FakeSessionDirectory } from './session/fake-identity';
import { MemorySessionStore } from './session/memory-store';
import { createSessionRedis } from './session/redis-connection';
import { RedisSessionStore } from './session/redis-store';
import { SessionService } from './session/session-service';
import type {
  IdentityProvider,
  LoginCompletion,
  LoginStart,
  RefreshResult,
  RevocationResult,
  SessionDirectory,
  SessionStore,
} from './session/types';
import { UPSTREAM_TIMEOUT_MS } from './upstream';

/** Dependências do BFF montadas uma vez por processo (substituíveis nos testes). */
export interface BffRuntime {
  readonly config: WebConfig;
  readonly identity: IdentityProvider;
  /** A API como diretório de identidade (`POST /internal/session-events`). */
  readonly directory: SessionDirectory;
  /** *Flow* de recuperação de senha do IdP (US-089). */
  readonly recovery: PasswordRecovery;
  readonly sessions: SessionService;
  readonly authRateLimiter: AuthRateLimiter;
  /** Subchave AES-256 do cookie de transação do login (RN-IAM-02). */
  readonly transactionKey: Buffer;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  /** Timeout de cada chamada à API (30 s — architecture.md §8.4). */
  readonly upstreamTimeoutMs: number;
}

/**
 * Sem provedor configurado (nem fake nem cliente OIDC): login recusado (SCR-001 "indisponível") e
 * renovação tratada como falha transitória (a sessão nunca é destruída por isso).
 */
export class UnconfiguredIdentityProvider implements IdentityProvider {
  readonly kind = 'oidc' as const;

  beginLogin(): Promise<LoginStart> {
    return Promise.reject(new Error('Provedor de identidade não configurado.'));
  }

  completeLogin(): Promise<LoginCompletion> {
    return Promise.resolve({ ok: false, reason: 'PROVIDER_UNAVAILABLE' });
  }

  refresh(): Promise<RefreshResult> {
    return Promise.resolve({ kind: 'transient' });
  }

  /** Nada a revogar: o provedor fake não emite refresh token real. */
  revokeRefreshToken(): Promise<RevocationResult> {
    return Promise.resolve('skipped');
  }

  endSessionUrl(): Promise<string | null> {
    return Promise.resolve(null);
  }
}

function identityFor(config: WebConfig, now: () => number, fetchImpl: typeof fetch) {
  if (config.oidc.fakeSigningKey) {
    return new FakeIdentityProvider({
      signingKey: config.oidc.fakeSigningKey,
      issuer: config.oidc.issuerUrl,
      audience: config.oidc.audience,
      now,
    });
  }
  if (config.oidc.clientSecret) {
    return new OidcIdentityProvider({
      issuer: config.oidc.issuerUrl,
      clientId: config.oidc.clientId,
      clientSecret: config.oidc.clientSecret,
      scopes: config.oidc.scopes,
      redirectUri: config.oidc.redirectUri,
      postLogoutRedirectUri: config.oidc.postLogoutRedirectUri,
      fetch: fetchImpl,
      now,
    });
  }
  return new UnconfiguredIdentityProvider();
}

function recoveryFor(config: WebConfig, now: () => number, fetchImpl: typeof fetch) {
  if (config.oidc.fakeSigningKey) return new FakePasswordRecovery(config.appOrigin);
  // Não depende do cliente confidencial: só da origem do Authentik e do slug do *flow*.
  return new AuthentikPasswordRecovery({
    issuerUrl: config.oidc.issuerUrl,
    flowSlug: config.oidc.recoveryFlowSlug,
    fetch: fetchImpl,
    now,
  });
}

export interface RuntimeOverrides {
  readonly identity?: IdentityProvider;
  readonly directory?: SessionDirectory;
  readonly recovery?: PasswordRecovery;
  readonly store?: SessionStore;
  readonly rateLimitCounter?: RateLimitCounter;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly upstreamTimeoutMs?: number;
}

export function createBffRuntime(config: WebConfig, overrides: RuntimeOverrides = {}): BffRuntime {
  const now = overrides.now ?? Date.now;
  const fetchImpl: typeof fetch = overrides.fetch ?? ((input, init) => fetch(input, init));
  const identity = overrides.identity ?? identityFor(config, now, fetchImpl);
  const directory =
    overrides.directory ??
    (config.oidc.fakeSigningKey
      ? new FakeSessionDirectory()
      : new ApiSessionDirectory({
          apiInternalUrl: config.apiInternalUrl,
          serviceToken: config.internalServiceToken,
          fetch: fetchImpl,
        }));
  const master = masterKey(config.session.encryptionKey);
  const redis =
    (!overrides.store || !overrides.rateLimitCounter) && config.session.redisUrl
      ? createSessionRedis(config.session.redisUrl)
      : null;
  const store =
    overrides.store ??
    (redis
      ? new RedisSessionStore(redis, {
          appEnv: config.appEnv,
          tokenKey: deriveKey(master, 'session-tokens'),
          now,
        })
      : new MemorySessionStore(now));
  const counter =
    overrides.rateLimitCounter ??
    (redis ? new RedisRateLimitCounter(redis) : new MemoryRateLimitCounter());
  return {
    config,
    identity,
    directory,
    recovery: overrides.recovery ?? recoveryFor(config, now, fetchImpl),
    sessions: new SessionService(store, identity, now),
    authRateLimiter: new AuthRateLimiter(counter, {
      limit: config.authRateLimitPerMinute,
      keyPrefix: `cf:${config.appEnv}:rl:auth:`,
      now,
      onError: (error) => {
        log('warn', 'auth.rate_limit_degraded', {
          errorName: error instanceof Error ? error.name : 'unknown',
        });
      },
    }),
    transactionKey: deriveKey(master, 'login-transaction'),
    fetch: fetchImpl,
    now,
    upstreamTimeoutMs: overrides.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS,
  };
}

// Guardado em globalThis para sobreviver ao HMR do `next dev` (sessões em memória).
const globalRuntime = globalThis as typeof globalThis & { __contrataflowBff?: BffRuntime };

export function bffRuntime(): BffRuntime {
  globalRuntime.__contrataflowBff ??= createBffRuntime(webConfig());
  return globalRuntime.__contrataflowBff;
}

/** Só para testes: injeta (ou descarta, com `undefined`) o runtime. */
export function setBffRuntimeForTests(runtime: BffRuntime | undefined): void {
  if (runtime) globalRuntime.__contrataflowBff = runtime;
  else delete globalRuntime.__contrataflowBff;
}
