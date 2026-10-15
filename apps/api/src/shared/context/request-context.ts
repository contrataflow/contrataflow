import { AsyncLocalStorage } from 'node:async_hooks';

import { uuidv7 } from '@contrataflow/observability';

/**
 * Quem age: `ANONYMOUS` até a autenticação; `USER` (pessoa autenticada); `SYSTEM` (job — FA-01 da
 * US-073); `PLATFORM_OPERATOR`/`INTEGRATION` reservados (DEC-139, MVP 3).
 */
export type ActorType = 'ANONYMOUS' | 'USER' | 'SYSTEM' | 'PLATFORM_OPERATOR' | 'INTEGRATION';

/**
 * Contexto de requisição (DEC-132 · architecture.md §6.1), aberto pelo middleware antes de
 * qualquer guard e completado pelos guards. Disponível em qualquer camada sem parâmetros.
 */
export interface RequestContext {
  readonly correlationId: string;
  /** Um salto HTTP (observability.md §3); ausente em jobs. */
  readonly requestId?: string;
  /** IP real do cliente (`X-Forwarded-For` só de proxy confiável — security.md §8); `''` em jobs. */
  readonly ip: string;
  readonly userAgent: string;
  /** SHA-256 do id de sessão do BFF (`AuditLog.sessionIdHash` — authentication.md §5). */
  readonly sessionIdHash?: string;
  readonly actor: {
    readonly type: ActorType;
    readonly userId: string | null;
    readonly membershipId: string | null;
    /** Nome exibido do usuário ou do job, congelado na auditoria (`AuditLog.actorName`). */
    readonly name?: string | null;
    /** Acesso de suporte em nome de alguém (DEC-139 · FA-02 da US-073). */
    readonly onBehalfOfUserId?: string | null;
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
  initial: Pick<
    RequestContext,
    'correlationId' | 'ip' | 'userAgent' | 'requestId' | 'sessionIdHash'
  >,
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
  scope: {
    readonly tenantId: string;
    readonly userId: string;
    readonly membershipId: string;
    readonly actorName?: string | null;
  },
  fn: () => T,
): T {
  const current = requireRequestContext();
  return storage.run(
    {
      value: {
        ...current,
        tenantId: scope.tenantId,
        actor: {
          type: 'USER',
          userId: scope.userId,
          membershipId: scope.membershipId,
          name: scope.actorName ?? null,
        },
      },
    },
    fn,
  );
}

/**
 * Executa `fn` com os dados do cliente informados por quem chama a API em nome dele, num contexto
 * filho. Uso restrito ao contrato BFF → API de sessão (US-087), em que a requisição vem do servidor
 * do BFF e o IP, o user-agent e a sessão do navegador chegam no corpo, já validados.
 */
export function runWithClientDetails<T>(
  client: {
    readonly ip: string | null;
    readonly userAgent: string | null;
    readonly sessionIdHash: string;
  },
  fn: () => T,
): T {
  const current = requireRequestContext();
  return storage.run(
    {
      value: {
        ...current,
        ip: client.ip ?? '',
        userAgent: client.userAgent ?? '',
        sessionIdHash: client.sessionIdHash,
      },
    },
    fn,
  );
}

export interface SystemActor {
  /** Nome do job, gravado em `AuditLog.actorName` (ex.: "Job de partições da auditoria"). */
  readonly name: string;
  /** Tenant do job; `null` em jobs de plataforma. */
  readonly tenantId: string | null;
  /** Correlação herdada de quem disparou o job; ausente → UUIDv7 novo (FA-04 da US-073). */
  readonly correlationId?: string;
}

/**
 * Contexto de um job da própria API (ator `SYSTEM` — FA-01/FA-04 da US-073): sem usuário, vínculo,
 * IP nem user-agent. Jobs do worker abrem o contexto a partir do envelope (DEC-164 · US-083).
 */
export function runAsSystem<T>(actor: SystemActor, fn: () => T): T {
  return storage.run(
    {
      value: {
        correlationId: actor.correlationId ?? uuidv7(),
        ip: '',
        userAgent: '',
        actor: { type: 'SYSTEM', userId: null, membershipId: null, name: actor.name },
        tenantId: actor.tenantId,
        amr: [],
        authTime: null,
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
