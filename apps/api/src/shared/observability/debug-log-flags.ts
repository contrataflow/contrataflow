import { Logger } from '@nestjs/common';

/*
 * Debug temporário por `correlationId` ou `tenantId` (observability.md §2.5 — PROPOSTA · FA-03).
 * O mecanismo de flag operacional ainda não existe (lacuna registrada na US-084): aqui fica só a
 * regra de acesso — apenas operador da plataforma, TTL ≤ 1 h, escopo identificado — com o aviso
 * `observability.debug_flag_denied`. Nenhuma rota usa isto; o nível efetivo segue `LOG_LEVEL`.
 */

export const DEBUG_FLAG_MAX_TTL_MS = 3_600_000;

export interface DebugFlagRequest {
  readonly actor: { readonly userId: string | null; readonly platformOperator: boolean };
  readonly scope: { readonly correlationId?: string; readonly tenantId?: string };
  readonly ttlMs: number;
}

export type DebugFlagDenial = 'NOT_PLATFORM_OPERATOR' | 'TTL_OUT_OF_RANGE' | 'SCOPE_MISSING';

export type DebugFlagDecision =
  | { readonly granted: true; readonly expiresAt: Date }
  | { readonly granted: false; readonly reason: DebugFlagDenial };

const logger = new Logger('Observability');

export class DebugLogFlags {
  private readonly active = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  activate(request: DebugFlagRequest): DebugFlagDecision {
    const reason = this.denialReason(request);
    if (reason) {
      logger.warn(
        { event: 'observability.debug_flag_denied', reason, userId: request.actor.userId },
        'debug flag denied',
      );
      return { granted: false, reason };
    }
    const expiresAt = this.now() + request.ttlMs;
    for (const key of scopeKeys(request.scope)) this.active.set(key, expiresAt);
    return { granted: true, expiresAt: new Date(expiresAt) };
  }

  /** Há flag vigente para o contexto informado? */
  isActive(scope: DebugFlagRequest['scope']): boolean {
    const now = this.now();
    return scopeKeys(scope).some((key) => (this.active.get(key) ?? 0) > now);
  }

  private denialReason(request: DebugFlagRequest): DebugFlagDenial | null {
    if (!request.actor.platformOperator) return 'NOT_PLATFORM_OPERATOR';
    if (request.ttlMs <= 0 || request.ttlMs > DEBUG_FLAG_MAX_TTL_MS) return 'TTL_OUT_OF_RANGE';
    if (scopeKeys(request.scope).length === 0) return 'SCOPE_MISSING';
    return null;
  }
}

function scopeKeys(scope: DebugFlagRequest['scope']): string[] {
  return [
    ...(scope.correlationId ? [`correlation:${scope.correlationId}`] : []),
    ...(scope.tenantId ? [`tenant:${scope.tenantId}`] : []),
  ];
}
