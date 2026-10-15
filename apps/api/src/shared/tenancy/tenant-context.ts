import { tenantContextMissing } from './isolation.js';
import type { IsolationBarrier, IsolationDetails } from './isolation.js';
import type { AccessMode, ActorType } from '../context/request-context.js';
import { currentRequestContext } from '../context/request-context.js';
import { isUuid } from '../database/ids.js';

/**
 * Contexto de tenant da requisição ou do job (US-100 · fluxo principal, passo 5): a parte do
 * `RequestContext` que identifica o tenant, o ator e a correlação. Aberto pelo `TenantContextGuard`
 * (rotas `TENANT`), pela base de jobs (`TenantJob`) ou por um caso de uso `PLATFORM` sobre um
 * tenant alvo; imutável enquanto durar (RN-TEN-21).
 */
export interface TenantContextValue {
  readonly tenantId: string;
  readonly userId: string | null;
  readonly membershipId: string | null;
  readonly actorType: ActorType;
  readonly correlationId: string;
  readonly requestId: string | null;
  readonly accessMode: AccessMode;
}

/** Contexto de tenant ativo ou `null` (fora de requisição/job, ou rota sem tenant). */
function current(): TenantContextValue | null {
  const context = currentRequestContext();
  const tenantId = context?.tenantId ?? null;
  if (!context || tenantId === null || !isUuid(tenantId)) return null;
  return {
    tenantId,
    userId: context.actor.userId,
    membershipId: context.actor.membershipId,
    actorType: context.actor.type,
    correlationId: context.correlationId,
    requestId: context.requestId ?? null,
    accessMode: context.accessMode,
  };
}

/**
 * Contexto de tenant obrigatório: sem ele, log `error security.tenant_context_missing`, métrica e
 * `TenantContextMissingError` (falha fechada — V-06).
 */
function getOrThrow(
  barrier: IsolationBarrier = 'context',
  details: IsolationDetails = {},
): TenantContextValue {
  const value = current();
  if (value === null) throw tenantContextMissing(barrier, details);
  return value;
}

export const TenantContext = { current, getOrThrow } as const;
