import type { HealthCheck } from '@contrataflow/observability';
import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import { TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { TokenVerifierPort } from '#shared/auth/ports.js';
import { HealthRegistry } from '#shared/observability/health.module.js';

import { JwksTokenVerifier } from './jwks-token-verifier.js';

/**
 * JWKS do Authentik no `/health/ready` (US-085 · observability.md §6.2 · FA-04): CRÍTICO só no
 * *startup* — sem nenhuma chave carregada a API não valida token algum (`fail`); depois de carregado,
 * DEGRADÁVEL enquanto o cache vale — refresh falhando vira `warn` com a idade do cache (RB-04).
 */
export function jwksHealthCheck(
  verifier: Pick<JwksTokenVerifier, 'cacheState' | 'warmUp'>,
  timeoutMs: number,
): HealthCheck {
  return {
    name: 'authentik-jwks',
    measurement: 'cacheAge',
    criticality: 'critical',
    timeoutMs,
    probe: async () => {
      if (verifier.cacheState().ageSeconds === null) await verifier.warmUp();
      const state = verifier.cacheState();
      if (state.ageSeconds === null) return { status: 'fail', output: 'not_loaded' };
      return {
        status: state.lastRefreshFailed ? 'warn' : 'pass',
        observedValue: state.ageSeconds,
        observedUnit: 's',
        ...(state.lastRefreshFailed ? { output: 'stale_cache' as const } : {}),
      };
    },
  };
}

/** Registra o check só com o JWKS real (o provedor fake de local/dev/test não tem dependência). */
@Injectable()
export class JwksHealthIndicator implements OnModuleInit {
  constructor(
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifierPort,
    private readonly health: HealthRegistry,
  ) {}

  onModuleInit(): void {
    if (!(this.verifier instanceof JwksTokenVerifier)) return;
    this.health.register(jwksHealthCheck(this.verifier, this.health.timeoutFor('http')));
  }
}
