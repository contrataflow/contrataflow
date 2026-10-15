import { OUTBOX_NOTIFY_CHANNEL } from '@contrataflow/types';
import { Logger } from '@nestjs/common';

import type { OutboxDatabase, RelaySession } from '#shared/database/outbox-database.js';

import type { DomainEventsPublisher } from './domain-events.publisher.js';
import { toPublishableEvent } from './outbox-record.js';
import type { OutboxRecord, PublishableEvent } from './outbox-record.js';
import { outboxMetrics } from './outbox-telemetry.js';
import { OutboxRepository } from './outbox.repository.js';
import { exponentialJitterMs } from '../queues/queue-options.js';

/** Chave da trava consultiva de líder (`hashtextextended` → bigint estável entre réplicas). */
export const RELAY_LOCK_KEY = 'cf:outbox-relay';

export interface OutboxRelayOptions {
  /** Linhas por lote (RN-FND-55: até 100). */
  readonly batchSize?: number;
  /** *Polling* de segurança com o relay ocioso (o NOTIFY só reduz a latência). */
  readonly pollIntervalMs?: number;
  /** Intervalo das réplicas em espera para tentar a trava (FA-02: assumir em ≤ 5 s). */
  readonly standbyRetryMs?: number;
  /** Teto da espera após falha de PostgreSQL/Redis no ciclo (FA-01: até 30 s). */
  readonly maxCycleBackoffMs?: number;
  /** Tentativas por linha inválida antes de `FAILED` (RN-FND-57). */
  readonly maxPublishAttempts?: number;
}

export type RelayLogger = Pick<Logger, 'log' | 'warn' | 'error'>;

export interface OutboxRelayDeps {
  readonly database: OutboxDatabase;
  readonly publisher: DomainEventsPublisher;
  readonly repository?: OutboxRepository;
  readonly logger?: RelayLogger;
  readonly now?: () => Date;
  readonly random?: () => number;
}

export interface RelayCycleResult {
  readonly claimed: number;
  readonly published: number;
  readonly retried: number;
  readonly failed: number;
}

/** Espera entre ciclos com falha: 1 s, 2 s, 4 s… até o teto (FA-01). */
export function cycleBackoffMs(consecutiveFailures: number, maxMs = 30_000): number {
  return Math.min(maxMs, 1_000 * 2 ** Math.max(0, consecutiveFailures - 1));
}

/** Percentil 95 (método do posto mais próximo) de uma lista não vazia. */
function p95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : 'UnknownError');

/**
 * Relay do outbox (US-082 · queues.md §5.3 · DEC-072): uma réplica líder por trava consultiva de
 * sessão; a cada ciclo, uma transação trava até 100 linhas `PENDING` com SKIP LOCKED, publica as
 * válidas na fila `domain-events` (`jobId = eventId`) e as marca `PUBLISHED` no mesmo COMMIT.
 * Linha inválida vai para backoff isolado; falha de Redis/PostgreSQL desfaz o lote inteiro.
 * Entrega *at-least-once*: queda entre o `addBulk` e o COMMIT republica o lote, e o `jobId`
 * deduplica.
 */
export class OutboxRelay {
  private readonly repository: OutboxRepository;
  private readonly logger: RelayLogger;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly standbyRetryMs: number;
  private readonly maxCycleBackoffMs: number;
  private readonly maxPublishAttempts: number;

  private running = false;
  private leader = false;
  private loop: Promise<void> | undefined;
  /** NOTIFY recebido enquanto o ciclo rodava: o próximo não espera o *polling*. */
  private notified = false;
  private readonly waiters = new Set<{ wake: () => void; wakeable: boolean }>();

  constructor(
    private readonly deps: OutboxRelayDeps,
    options: OutboxRelayOptions = {},
  ) {
    this.repository = deps.repository ?? new OutboxRepository();
    this.logger = deps.logger ?? new Logger('OutboxRelay');
    this.now = deps.now ?? (() => new Date());
    this.random = deps.random ?? Math.random;
    this.batchSize = options.batchSize ?? 100;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.standbyRetryMs = options.standbyRetryMs ?? 5_000;
    this.maxCycleBackoffMs = options.maxCycleBackoffMs ?? 30_000;
    this.maxPublishAttempts = options.maxPublishAttempts ?? 10;
  }

  /** `true` enquanto esta réplica detém a trava de líder. */
  get isLeader(): boolean {
    return this.leader;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.leadershipLoop();
  }

  /** Encerra o laço; a trava sai com a conexão de sessão (o lote em andamento conclui antes). */
  async stop(): Promise<void> {
    this.running = false;
    for (const waiter of this.waiters) waiter.wake();
    await this.loop;
    this.loop = undefined;
  }

  /** `true` depois de `stop()` (método: o laço não pode presumir o valor lido antes do await). */
  private stopping(): boolean {
    return !this.running;
  }

  /** Acorda o laço (NOTIFY `cf_outbox` ou perda da sessão). */
  wake(): void {
    this.notified = true;
    for (const waiter of this.waiters) if (waiter.wakeable) waiter.wake();
  }

  /** Um ciclo: trava, valida, publica e marca — tudo numa transação. */
  async runCycle(): Promise<RelayCycleResult> {
    const startedAt = performance.now();
    const outcome = await this.deps.database.transaction(async (client) => {
      const records = await this.repository.claimPendingBatch(client, this.batchSize);
      if (records.length === 0) return { claimed: 0, published: [], retried: 0, failed: 0 };
      const enqueuedAt = this.now();
      const valid: PublishableEvent[] = [];
      let retried = 0;
      let failed = 0;
      for (const record of records) {
        const check = toPublishableEvent(record, enqueuedAt);
        if (check.ok) {
          valid.push(check.event);
        } else if (await this.rejectRecord(client, record, check.reason)) {
          failed += 1;
        } else {
          retried += 1;
        }
      }
      await this.deps.publisher.publish(valid);
      await this.repository.markPublished(
        client,
        valid.map((event) => event.jobId),
      );
      return { claimed: records.length, published: valid, retried, failed };
    });

    const metrics = outboxMetrics();
    if (outcome.claimed > 0) {
      metrics.batchSize.record(outcome.claimed);
      metrics.batchDuration.record((performance.now() - startedAt) / 1_000);
    }
    if (outcome.published.length > 0) {
      const publishedAt = this.now().getTime();
      const lags = outcome.published.map((event) => publishedAt - event.occurredAt.getTime());
      for (const [index, event] of outcome.published.entries()) {
        metrics.published.add(1, { event_type: event.eventType });
        metrics.lag.record((lags[index] ?? 0) / 1_000);
      }
      this.logger.log(
        {
          event: 'outbox.relay_batch_published',
          batchSize: outcome.published.length,
          lagMsP95: p95(lags),
        },
        'outbox batch published',
      );
    }
    return {
      claimed: outcome.claimed,
      published: outcome.published.length,
      retried: outcome.retried,
      failed: outcome.failed,
    };
  }

  /** Linha inválida (V-04): backoff isolado ou `FAILED`. Devolve `true` se virou `FAILED`. */
  private async rejectRecord(
    client: Parameters<OutboxRepository['markRetry']>[0],
    record: OutboxRecord,
    reason: string,
  ): Promise<boolean> {
    const attempts = record.attempts + 1;
    outboxMetrics().publishErrors.add(1, { reason: 'invalid_row' });
    if (attempts >= this.maxPublishAttempts) {
      await this.repository.markFailed(client, record.id, attempts, reason);
      outboxMetrics().failed.add(1, { event_type: record.event_type });
      this.logger.error(
        {
          event: 'outbox.relay_failed_permanently',
          eventId: record.id,
          eventType: record.event_type,
          attempts,
          lastError: reason,
        },
        'outbox event failed permanently',
      );
      return true;
    }
    const nextAttemptAt = new Date(
      this.now().getTime() + exponentialJitterMs(attempts, undefined, this.random),
    );
    await this.repository.markRetry(client, record.id, attempts, nextAttemptAt, reason);
    this.logger.warn(
      {
        event: 'outbox.relay_retry',
        eventId: record.id,
        attempts,
        nextAttemptAt: nextAttemptAt.toISOString(),
      },
      'outbox event scheduled for retry',
    );
    return false;
  }

  private async leadershipLoop(): Promise<void> {
    let failures = 0;
    while (this.running) {
      let session: RelaySession | undefined;
      try {
        session = await this.deps.database.openSession();
        const { rows } = await session.query<{ acquired: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
          [RELAY_LOCK_KEY],
        );
        failures = 0;
        if (rows[0]?.acquired !== true) {
          // Réplica em espera (RN-FND-54): não processa lotes; tenta de novo em 5 s.
          await this.wait(this.standbyRetryMs, false);
          continue;
        }
        this.leader = true;
        this.logger.log({ event: 'outbox.relay_leader_acquired' }, 'outbox relay leader acquired');
        session.onLost(() => {
          this.wake();
        });
        await session.listen(OUTBOX_NOTIFY_CHANNEL, () => {
          this.wake();
        });
        await this.lead(session);
      } catch (error) {
        failures += 1;
        this.cycleFailed(error, failures);
        await this.wait(cycleBackoffMs(failures, this.maxCycleBackoffMs), false);
      } finally {
        if (this.leader) {
          this.leader = false;
          // Perda involuntária (conexão caiu); no stop() a trava é liberada de propósito.
          if (!this.stopping()) {
            this.logger.warn({ event: 'outbox.relay_leader_lost' }, 'outbox relay leader lost');
          }
        }
        await session?.close();
      }
    }
  }

  /** Laço do líder: ciclos seguidos com lote cheio; ocioso, espera NOTIFY ou o *polling*. */
  private async lead(session: RelaySession): Promise<void> {
    let failures = 0;
    while (this.running && !session.lost) {
      try {
        const result = await this.runCycle();
        failures = 0;
        if (result.claimed >= this.batchSize) continue;
        await this.idle();
      } catch (error) {
        failures += 1;
        this.cycleFailed(error, failures);
        await this.wait(cycleBackoffMs(failures, this.maxCycleBackoffMs), false);
      }
    }
  }

  private cycleFailed(error: unknown, consecutiveFailures: number): void {
    outboxMetrics().publishErrors.add(1, { reason: 'cycle' });
    this.logger.warn(
      {
        event: 'outbox.relay_cycle_failed',
        cause: errorName(error),
        consecutiveFailures,
        retryInMs: cycleBackoffMs(consecutiveFailures, this.maxCycleBackoffMs),
      },
      'outbox relay cycle failed',
    );
  }

  private async idle(): Promise<void> {
    if (this.notified) {
      this.notified = false;
      return;
    }
    await this.wait(this.pollIntervalMs, true);
    this.notified = false;
  }

  /** Espera interrompível por `stop()` (e pelo NOTIFY, se `wakeable`). */
  private wait(ms: number, wakeable: boolean): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter = {
        wakeable,
        wake: () => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve();
        },
      };
      const timer = setTimeout(waiter.wake, ms);
      this.waiters.add(waiter);
    });
  }
}
