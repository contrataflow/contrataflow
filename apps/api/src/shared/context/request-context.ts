import { AsyncLocalStorage } from 'node:async_hooks';

import { uuidv7 } from '@contrataflow/observability';

/**
 * Quem age: `ANONYMOUS` até a autenticação; `USER` (pessoa autenticada); `SYSTEM` (job — FA-01 da
 * US-073); `PLATFORM_OPERATOR`/`INTEGRATION` reservados (DEC-139, MVP 3).
 */
export type ActorType = 'ANONYMOUS' | 'USER' | 'SYSTEM' | 'PLATFORM_OPERATOR' | 'INTEGRATION';

/**
 * Modo de acesso ao tenant (US-100 · RN-TEN-37): `FULL` normal; `READ_EXPORT` em instituição em
 * `OFFBOARDING` (só leitura e as rotas `@OffboardingExport()`).
 */
export type AccessMode = 'FULL' | 'READ_EXPORT';

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
  /**
   * `null` em rotas sem tenant (públicas ou anteriores ao guard de tenant). Imutável depois de
   * definido (RN-TEN-21): só um contexto filho (`runWithTenantScope`, jobs) muda de tenant.
   */
  readonly tenantId: string | null;
  readonly accessMode: AccessMode;
  /** Métodos de autenticação do token (`amr`) — usados pelo guard de MFA (POL-14). */
  readonly amr: readonly string[];
  /**
   * Perfis vigentes (`Role.key`) do vínculo ativo, resolvidos pelo guard de tenant. Ponte até a
   * autorização por permissões efetivas (US-097): `AccessFacade.assertCan` lê daqui.
   */
  readonly roleKeys?: readonly string[];
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
        accessMode: 'FULL',
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
 * Uso restrito a rotas `@TenantScope('CROSS_TENANT_LOOKUP')` que, depois de conferir o vínculo do próprio usuário,
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
  // RN-TEN-21: um contexto que já tem tenant nunca abre o de outro tenant.
  if (current.tenantId !== null && current.tenantId !== scope.tenantId) {
    throw new TenantContextImmutableError();
  }
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
        accessMode: 'FULL',
        amr: [],
        authTime: null,
      },
    },
    fn,
  );
}

export interface PlatformOperatorActor {
  readonly userId: string;
  /** Nome do operador, congelado em `AuditLog.actorName`. */
  readonly name: string;
  /** Tenant afetado pela ação de plataforma; `null` para auditoria de plataforma (RN-TEN-15). */
  readonly tenantId: string | null;
}

/**
 * Ação de plataforma sobre um tenant (US-099 · RN-TEN-15 · DEC-139): ator `PLATFORM_OPERATOR` no
 * tenant afetado, para que auditoria e eventos fiquem visíveis ao cliente — sem vínculo do
 * operador. Herda correlação, IP e user-agent da requisição (`/platform/*`, sem tenant) ou abre um
 * contexto novo (CLI). Dentro de uma rota de tenant é erro de programação (RN-TEN-21).
 */
export function runAsPlatformOperator<T>(operator: PlatformOperatorActor, fn: () => T): T {
  const current = currentRequestContext();
  if (current && current.actor.type !== 'PLATFORM_OPERATOR' && current.tenantId !== null) {
    throw new TenantContextImmutableError();
  }
  return storage.run(
    {
      value: {
        correlationId: current?.correlationId ?? uuidv7(),
        ...(current?.requestId === undefined ? {} : { requestId: current.requestId }),
        ...(current?.sessionIdHash === undefined ? {} : { sessionIdHash: current.sessionIdHash }),
        ip: current?.ip ?? '',
        userAgent: current?.userAgent ?? '',
        actor: {
          type: 'PLATFORM_OPERATOR',
          userId: operator.userId,
          membershipId: null,
          name: operator.name,
        },
        tenantId: operator.tenantId,
        accessMode: 'FULL',
        amr: current?.amr ?? [],
        authTime: current?.authTime ?? null,
      },
    },
    fn,
  );
}

/**
 * Contexto de um job consumido da fila (US-100 · FA-03 · DEC-164): tenant, ator e correlação vêm
 * do `JobMeta` validado; sem IP nem user-agent. Aberto pela base `TenantJob` antes do handler.
 */
export function runInJobRequestContext<T>(
  job: {
    readonly correlationId: string;
    readonly tenantId: string | null;
    readonly actor: {
      readonly type: Exclude<ActorType, 'ANONYMOUS'>;
      readonly userId: string | null;
      readonly membershipId: string | null;
    };
    /** `fila:job`, gravado como `actorName` quando o ator é `SYSTEM`. */
    readonly jobName: string;
  },
  fn: () => T,
): T {
  return storage.run(
    {
      value: {
        correlationId: job.correlationId,
        ip: '',
        userAgent: '',
        actor: {
          type: job.actor.type,
          userId: job.actor.userId,
          membershipId: job.actor.membershipId,
          name: job.actor.type === 'SYSTEM' ? job.jobName : null,
        },
        tenantId: job.tenantId,
        accessMode: 'FULL',
        amr: [],
        authTime: null,
      },
    },
    fn,
  );
}

/**
 * Tentativa de trocar o tenant de um contexto que já tem tenant (RN-TEN-21): erro de programação.
 * Quem precisa agir em outro tenant abre um contexto filho (casos de uso `PLATFORM`, jobs).
 */
export class TenantContextImmutableError extends Error {
  constructor() {
    super('O tenant do contexto é imutável durante a requisição ou o job.');
    this.name = 'TenantContextImmutableError';
  }
}

/** Completa o contexto atual (uso exclusivo dos guards do pipeline). */
export function updateRequestContext(
  patch: Partial<Omit<RequestContext, 'correlationId' | 'ip' | 'userAgent' | 'requestId'>>,
): RequestContext {
  const holder = storage.getStore();
  if (!holder) throw new RequestContextMissingError();
  const current = holder.value.tenantId;
  if (patch.tenantId !== undefined && current !== null && patch.tenantId !== current) {
    throw new TenantContextImmutableError();
  }
  holder.value = { ...holder.value, ...patch };
  return holder.value;
}
