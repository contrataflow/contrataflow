import { isSessionExpiryReason } from '@contrataflow/types';
import { sessionDeadline, sessionExpiry } from '@contrataflow/validation';
import type { SessionTombstone } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { SESSION_REGISTRY } from '#shared/sessions/session-registry.js';
import type { SessionRegistryPort } from '#shared/sessions/session-registry.js';

import { IDENTITY_CLOCK, SESSION_AUDIT } from './ports.js';
import type { Clock, SessionAuditPort } from './ports.js';
import { sessionMetrics } from './session-telemetry.js';

/** Validade da trava da varredura: menor que o ciclo de 60 s, para a próxima rodada a obter. */
export const SESSION_SWEEP_LOCK_TTL_MS = 50_000;

/** Chaves com prazo vencido tratadas por ciclo; o que sobrar fica para o ciclo seguinte. */
export const SESSION_SWEEP_BATCH_SIZE = 500;

/**
 * Falhas de auditoria seguidas que encerram o ciclo: é o banco fora, e insistir em cada chave só
 * acumularia esperas de conexão. O que ficou é refeito no próximo ciclo, com o horário original.
 */
export const SESSION_SWEEP_MAX_CONSECUTIVE_DEFERRALS = 3;

export interface SessionSweepResult {
  /** Chaves vencidas examinadas no ciclo (inclui as adiadas e as reagendadas). */
  readonly processed: number;
  /** Auditorias gravadas agora (não conta as já gravadas antes nem as sem instituição). */
  readonly recorded: number;
  /** Auditorias que falharam (banco fora): o registro de encerramento fica para o próximo ciclo. */
  readonly deferred: number;
}

/** Resultado de uma chave: `recorded` = auditoria gravada agora; `settled` = nada pendente. */
type KeyOutcome = 'recorded' | 'settled' | 'deferred';

/** O que a chave vencida tem no Redis de sessões. */
type Pending =
  | { readonly kind: 'tombstone'; readonly tombstone: SessionTombstone }
  /** Sessão viva acessada depois: voltou para o conjunto de prazos, sem auditoria. */
  | { readonly kind: 'rescheduled' }
  /** Nem sessão viva nem registro de encerramento: sobrou só a entrada no conjunto de prazos. */
  | { readonly kind: 'gone' };

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * `RecordSessionEndingsCommand` (US-088 · RN-IAM-24/28 · authentication.md §7): a varredura que
 * grava `auth.session_end`/`auth.session_expired` das sessões que o BFF encerrou ou que venceram
 * sem ninguém voltar. Roda a cada 1 min no processo da API (DEC-071) e faz, por chave vencida:
 *
 * 1. Sessão viva que já passou do limite é encerrada aqui mesmo, com o horário do limite (não o
 *    desta varredura); sessão acessada depois só é reagendada.
 * 2. Auditoria do registro de encerramento (sem tokens), na instituição ativa da sessão, cada uma
 *    na sua transação, com o horário real do fato.
 * 3. Só DEPOIS do commit o registro de encerramento sai do Redis. Se o banco estiver fora, o
 *    registro fica e a gravação se repete no próximo ciclo com o horário original; `oncePerSession`
 *    impede registro duplicado caso a falha tenha ocorrido depois do commit.
 *
 * Uma réplica por ciclo (trava no Redis). Redis fora no meio do ciclo encerra o ciclo sem lançar.
 * Nada aqui loga a chave da sessão, tokens ou IP.
 */
@Injectable()
export class RecordSessionEndingsCommand {
  private readonly logger = new Logger('SessionSweep');

  constructor(
    @Inject(SESSION_REGISTRY) private readonly registry: SessionRegistryPort,
    @Inject(SESSION_AUDIT) private readonly audit: SessionAuditPort,
    @Inject(IDENTITY_CLOCK) private readonly clock: Clock,
  ) {}

  async run(): Promise<SessionSweepResult> {
    let processed = 0;
    let recorded = 0;
    let deferred = 0;
    if (this.registry.enabled) {
      try {
        // Sem a trava, outra réplica roda este ciclo.
        if (await this.registry.acquireSweepLock(SESSION_SWEEP_LOCK_TTL_MS)) {
          const now = this.clock().getTime();
          let consecutiveDeferrals = 0;
          for (const key of await this.registry.due(now, SESSION_SWEEP_BATCH_SIZE)) {
            const outcome = await this.sweep(key, now);
            processed += 1;
            if (outcome === 'recorded') recorded += 1;
            if (outcome === 'deferred') deferred += 1;
            consecutiveDeferrals = outcome === 'deferred' ? consecutiveDeferrals + 1 : 0;
            if (consecutiveDeferrals >= SESSION_SWEEP_MAX_CONSECUTIVE_DEFERRALS) break;
          }
        }
      } catch (error) {
        // Redis de sessões indisponível: o que ficou pendente é refeito no próximo ciclo.
        this.logger.warn(
          { event: 'auth.session_sweep_failed', reason: errorName(error) },
          'auth.session_sweep_failed',
        );
      }
    }
    if (processed > 0) {
      this.logger.log(
        { event: 'auth.sessions_swept', processed, recorded, deferred },
        'auth.sessions_swept',
      );
    }
    return { processed, recorded, deferred };
  }

  /** Uma chave vencida. Erro do Redis propaga (encerra o ciclo); falha da auditoria não. */
  private async sweep(key: string, now: number): Promise<KeyOutcome> {
    const pending = await this.findPending(key, now);
    if (pending.kind === 'rescheduled') return 'settled';
    // Sem instituição ativa (FA-07) não há trilha de tenant onde gravar: só limpa.
    if (pending.kind === 'gone' || pending.tombstone.activeTenantId === null) {
      await this.registry.forget(key);
      return 'settled';
    }

    const { tombstone } = pending;
    let result: 'recorded' | 'duplicate';
    try {
      result = await this.audit.sessionEnded(tombstone);
    } catch (error) {
      // Banco fora: o registro de encerramento fica no Redis e a gravação se repete no próximo ciclo.
      this.logger.warn(
        {
          event: 'auth.session_audit_deferred',
          endReason: tombstone.reason,
          reason: errorName(error),
        },
        'auth.session_audit_deferred',
      );
      return 'deferred';
    }
    if (result === 'recorded' && isSessionExpiryReason(tombstone.reason)) {
      sessionMetrics().expired.add(1, { reason: tombstone.reason });
    }
    // Pós-commit (RN-IAM-28): a auditoria já está gravada.
    await this.registry.forget(key);
    return result === 'recorded' ? 'recorded' : 'settled';
  }

  /**
   * O que a chave vencida tem no Redis. Sem registro de encerramento, a sessão viva pode ter
   * vencido sem ninguém voltar (a varredura a encerra com o horário do limite), ter sido acessada
   * depois (só reagenda) ou não existir mais (a chave sai do conjunto de prazos).
   */
  private async findPending(key: string, now: number): Promise<Pending> {
    const ended = await this.registry.readTombstone(key);
    if (ended) return { kind: 'tombstone', tombstone: ended };

    const live = await this.registry.readLive(key);
    // O encerramento grava o registro de encerramento ANTES de apagar o vivo: se o vivo sumiu
    // entre as duas leituras, o de encerramento já existe e não pode ser descartado aqui.
    if (live === null) return this.tombstoneOrGone(key);

    const expiry = sessionExpiry(live, now);
    if (expiry === null) {
      await this.registry.reschedule(key, sessionDeadline(live));
      return { kind: 'rescheduled' };
    }
    await this.registry.end({ header: live, reason: expiry.reason, occurredAt: expiry.occurredAt });
    // Quem encerrou primeiro (esta varredura, o BFF ou outra réplica) define o registro.
    return this.tombstoneOrGone(key);
  }

  private async tombstoneOrGone(key: string): Promise<Pending> {
    const tombstone = await this.registry.readTombstone(key);
    return tombstone ? { kind: 'tombstone', tombstone } : { kind: 'gone' };
  }
}
