import { AsyncLocalStorage } from 'node:async_hooks';

export type ActorType = 'ANONYMOUS' | 'USER';

/**
 * Contexto de requisição (DEC-132 · architecture.md §6.1), aberto pelo middleware antes de
 * qualquer guard e completado pelos guards. Disponível em qualquer camada sem parâmetros.
 */
export interface RequestContext {
  readonly correlationId: string;
  /** Um salto HTTP (observability.md §3); ausente em jobs. */
  readonly requestId?: string;
  readonly ip: string;
  readonly userAgent: string;
  readonly actor: {
    readonly type: ActorType;
    readonly userId: string | null;
    readonly membershipId: string | null;
  };
  /** `null` em rotas sem tenant (públicas ou anteriores ao guard de tenant). */
  readonly tenantId: string | null;
  /** Métodos de autenticação do token (`amr`) — usados pelo guard de MFA (POL-14). */
  readonly amr: readonly string[];
  readonly authTime: Date | null;
}

const storage = new AsyncLocalStorage<{ value: RequestContext }>();

/** Abre um contexto novo para `fn` (uma requisição, um job). */
export function runWithRequestContext<T>(
  initial: Pick<RequestContext, 'correlationId' | 'ip' | 'userAgent' | 'requestId'>,
  fn: () => T,
): T {
  return storage.run(
    {
      value: {
        ...initial,
        actor: { type: 'ANONYMOUS', userId: null, membershipId: null },
        tenantId: null,
        amr: [],
        authTime: null,
      },
    },
    fn,
  );
}

/** Contexto atual ou `undefined` fora de uma requisição. */
export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore()?.value;
}

/**
 * Campos de correlação de toda linha de log (RN-FND-71 · observability.md §2.2), lidos no momento
 * do log — o tenant e o usuário aparecem assim que os guards os definem. IP e user-agent ficam fora
 * (dado pessoal: só em logs de acesso e auditoria).
 */
export function requestContextLogFields(): Readonly<Record<string, string | null>> | undefined {
  const context = currentRequestContext();
  if (!context) return undefined;
  return {
    correlationId: context.correlationId,
    tenantId: context.tenantId,
    userId: context.actor.userId,
    membershipId: context.actor.membershipId,
  };
}

/** Erro de programação: código que exige contexto rodando fora dele (falha fechada). */
export class RequestContextMissingError extends Error {
  constructor() {
    super('RequestContext ausente: código executado fora de uma requisição ou job.');
    this.name = 'RequestContextMissingError';
  }
}

/** Contexto atual; lança `RequestContextMissingError` fora de uma requisição. */
export function requireRequestContext(): RequestContext {
  const context = currentRequestContext();
  if (!context) throw new RequestContextMissingError();
  return context;
}

/**
 * Executa `fn` com o tenant e o ator informados, num contexto filho (o da requisição não muda).
 * Uso restrito a rotas `@WithoutTenant()` que, depois de conferir o vínculo do próprio usuário,
 * precisam escrever no tenant escolhido (início de sessão — US-087).
 */
export function runWithTenantScope<T>(
  scope: { readonly tenantId: string; readonly userId: string; readonly membershipId: string },
  fn: () => T,
): T {
  const current = requireRequestContext();
  return storage.run(
    {
      value: {
        ...current,
        tenantId: scope.tenantId,
        actor: { type: 'USER', userId: scope.userId, membershipId: scope.membershipId },
      },
    },
    fn,
  );
}

/** Completa o contexto atual (uso exclusivo dos guards do pipeline). */
export function updateRequestContext(
  patch: Partial<Omit<RequestContext, 'correlationId' | 'ip' | 'userAgent' | 'requestId'>>,
): RequestContext {
  const holder = storage.getStore();
  if (!holder) throw new RequestContextMissingError();
  holder.value = { ...holder.value, ...patch };
  return holder.value;
}
