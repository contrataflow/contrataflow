import 'server-only';

import { webConfig } from '@/config/env';
import type { WebConfig } from '@/config/env';

import { FakeIdentityProvider } from './session/fake-identity';
import { MemorySessionStore } from './session/memory-store';
import { SessionService } from './session/session-service';
import type { IdentityProvider, LoginCompletion, LoginStart, RefreshResult } from './session/types';
import { UPSTREAM_TIMEOUT_MS } from './upstream';

/** Dependências do BFF montadas uma vez por processo (substituíveis nos testes). */
export interface BffRuntime {
  readonly config: WebConfig;
  readonly identity: IdentityProvider;
  readonly sessions: SessionService;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  /** Timeout de cada chamada à API (30 s — architecture.md §8.4). */
  readonly upstreamTimeoutMs: number;
}

/**
 * Sem provedor configurado (nem fake nem OIDC — US-087): login recusado com 503 e renovação
 * tratada como falha transitória (a sessão nunca é destruída por isso).
 */
export class UnconfiguredIdentityProvider implements IdentityProvider {
  readonly kind = 'oidc' as const;

  beginLogin(): Promise<LoginStart> {
    return Promise.reject(new Error('Provedor de identidade não configurado.'));
  }

  completeLogin(): Promise<LoginCompletion> {
    return Promise.resolve({ ok: false, reason: 'PROVIDER_ERROR' });
  }

  refresh(): Promise<RefreshResult> {
    return Promise.resolve({ kind: 'transient' });
  }

  endSessionUrl(): string | null {
    return null;
  }
}

export function createBffRuntime(
  config: WebConfig,
  overrides: Partial<Omit<BffRuntime, 'config' | 'sessions'>> & {
    readonly store?: MemorySessionStore;
  } = {},
): BffRuntime {
  const now = overrides.now ?? Date.now;
  const identity =
    overrides.identity ??
    (config.oidc.fakeSigningKey
      ? new FakeIdentityProvider({
          signingKey: config.oidc.fakeSigningKey,
          issuer: config.oidc.issuerUrl,
          audience: config.oidc.audience,
          now,
        })
      : new UnconfiguredIdentityProvider());
  const store = overrides.store ?? new MemorySessionStore();
  return {
    config,
    identity,
    sessions: new SessionService(store, identity, now),
    fetch: overrides.fetch ?? ((input, init) => fetch(input, init)),
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
