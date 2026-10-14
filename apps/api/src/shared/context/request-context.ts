import { AsyncLocalStorage } from 'node:async_hooks';

export type ActorType = 'ANONYMOUS' | 'USER';

/**
 * Contexto de requisição (DEC-132 · architecture.md §6.1), aberto pelo middleware antes de
 * qualquer guard e completado pelos guards. Disponível em qualquer camada sem parâmetros.
 */
export interface RequestContext {
  readonly correlationId: string;
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
  initial: Pick<RequestContext, 'correlationId' | 'ip' | 'userAgent'>,
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

/** Completa o contexto atual (uso exclusivo dos guards do pipeline). */
export function updateRequestContext(
  patch: Partial<Omit<RequestContext, 'correlationId' | 'ip' | 'userAgent'>>,
): RequestContext {
  const holder = storage.getStore();
  if (!holder) throw new RequestContextMissingError();
  holder.value = { ...holder.value, ...patch };
  return holder.value;
}
