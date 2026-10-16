import type { DomainEventEnvelope, MembershipEndReason } from '@contrataflow/types';
import type { EndSessionInput, SessionHeader } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';

import type { InlineEventHandler } from './inline-handlers.js';

/*
 * Encerramento de sessões por mudança de vínculo (US-088 · RN-IAM-27 · authentication.md §4/§7):
 * ao consumir `MembershipSuspended`/`MembershipRevoked`/`MembershipExpired`, encerra no Redis de
 * sessões apenas as sessões da instituição do evento cujo vínculo ativo é o do payload — quem tem
 * sessão em outra instituição continua nela. O efeito de acesso já é imediato (a API revalida o
 * vínculo em toda requisição — DEC-132); este consumidor tira a sessão do ar e deixa o registro de
 * encerramento para a varredura da api auditar (`auth.session_end`, RN-IAM-28) — o worker não
 * grava auditoria. Os eventos são produzidos por USR-10/USR-12 (US-092) e pelo job `maintenance`;
 * a rota é inline por routing key, em `routes.ts`.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const REASON_BY_ROUTING_KEY: ReadonlyMap<string, MembershipEndReason> = new Map([
  ['membership.suspended', 'MEMBERSHIP_SUSPENDED'],
  ['membership.revoked', 'MEMBERSHIP_REVOKED'],
  ['membership.expired', 'MEMBERSHIP_EXPIRED'],
]);

/** O que o handler usa do Redis de sessões (`SessionRedis` em produção; em memória nos testes). */
export interface SessionRegistry {
  /** Chaves das sessões indexadas sob o vínculo. */
  membersOf(membershipId: string): Promise<readonly string[]>;
  /** Cabeçalho do registro vivo; `null` se a sessão não existe mais. */
  readHeader(sessionKey: string): Promise<SessionHeader | null>;
  /** Tira do índice do vínculo uma entrada órfã ou velha, sem encerrar nada. */
  forget(membershipId: string, sessionKey: string): Promise<void>;
  /** `true` só para quem de fato encerrou a sessão. */
  end(input: EndSessionInput): Promise<boolean>;
}

/** Subconjunto do `Logger` do Nest usado aqui (campos estruturados + mensagem). */
export interface SessionTerminationLogger {
  log(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface SessionTerminationOptions {
  readonly now?: () => Date;
  readonly logger?: SessionTerminationLogger;
}

/**
 * Idempotente por natureza: a reentrega não encontra mais sessões vivas (o `SET NX` do registro de
 * encerramento ainda garante auditoria única se duas entregas correrem juntas). Falha do Redis
 * propaga — o job do `domain-events` é repetido pela fila e retoma de onde parou.
 */
export class SessionTerminationHandler implements InlineEventHandler {
  readonly name = 'SessionTerminationHandler';
  private readonly now: () => Date;
  private readonly logger: SessionTerminationLogger;

  constructor(
    private readonly sessions: SessionRegistry,
    options: SessionTerminationOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? new Logger('SessionTermination');
  }

  async handle(event: DomainEventEnvelope<Record<string, unknown>>): Promise<void> {
    const reason = REASON_BY_ROUTING_KEY.get(event.routingKey);
    // Evento de plataforma não tem instituição ativa para comparar.
    if (reason === undefined || event.tenantId === null) return;
    const membershipId = event.payload.membershipId;
    if (typeof membershipId !== 'string' || !UUID.test(membershipId)) return;

    let count = 0;
    for (const sessionKey of await this.sessions.membersOf(membershipId)) {
      const header = await this.sessions.readHeader(sessionKey);
      // Entrada órfã (sessão já encerrada) ou velha (a sessão trocou de instituição/vínculo depois
      // de indexada): sai do índice e a sessão, se existir, não é tocada.
      const current =
        header !== null &&
        header.activeTenantId === event.tenantId &&
        header.membershipId === membershipId;
      if (!current) {
        await this.sessions.forget(membershipId, sessionKey);
        continue;
      }
      const ended = await this.sessions.end({
        header,
        reason,
        occurredAt: this.now().getTime(),
      });
      if (ended) count += 1;
    }
    // Sem sessão viva (o caso comum) não há o que registrar; nunca se loga a chave da sessão.
    if (count > 0) {
      this.logger.log(
        { event: 'auth.sessions_terminated', membershipId, reason, count },
        'sessions terminated by membership change',
      );
    }
  }
}

/**
 * Ocupa a rota quando o Redis de sessões não está configurado (`local`/`dev`/`test` — ver
 * `config/sessions.ts`): sem ele o `DomainEventsProcessor` falharia a cada evento de vínculo
 * (handler não registrado → job repetido até a DLQ). Descarta o evento com um aviso, uma vez por
 * processo — nesses ambientes as sessões não estão no Redis, não há o que encerrar.
 */
export class SessionTerminationDisabled implements InlineEventHandler {
  readonly name = 'SessionTerminationHandler';
  private warned = false;

  constructor(
    private readonly logger: SessionTerminationLogger = new Logger('SessionTermination'),
  ) {}

  handle(_event: DomainEventEnvelope<Record<string, unknown>>): Promise<void> {
    if (!this.warned) {
      this.warned = true;
      this.logger.warn(
        { event: 'auth.session_termination_disabled' },
        'REDIS_SESSION_URL not set: membership events do not end sessions',
      );
    }
    return Promise.resolve();
  }
}
