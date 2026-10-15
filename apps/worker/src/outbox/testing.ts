import type {
  OutboxDatabase,
  RelaySession,
  SqlClient,
  SqlResult,
} from '#shared/database/outbox-database.js';

import type { DomainEventsPublisher } from './domain-events.publisher.js';
import type { OutboxRecord, PublishableEvent } from './outbox-record.js';
import { OutboxRepository } from './outbox.repository.js';

/*
 * Dublês em memória do banco e da fila para os testes unitários do relay (o comportamento real do
 * PostgreSQL — SKIP LOCKED, trava consultiva, NOTIFY — é coberto em test/outbox com Testcontainers).
 */

export interface MemoryRow extends OutboxRecord {
  attempts: number;
  status: 'PENDING' | 'PUBLISHED' | 'FAILED';
  next_attempt_at: Date | null;
  published_at: Date | null;
  last_error: string | null;
}

const NO_CLIENT: SqlClient = {
  query: <R extends object>(): Promise<SqlResult<R>> => Promise.resolve({ rows: [], rowCount: 0 }),
};

export class MemorySession implements RelaySession {
  lost = false;
  notify: (() => void) | undefined;
  private readonly lostCallbacks: (() => void)[] = [];

  constructor(private readonly db: MemoryOutboxDatabase) {}

  query<R extends object>(): Promise<SqlResult<R>> {
    const acquired = this.db.lockHolder === null || this.db.lockHolder === this;
    if (acquired) this.db.lockHolder = this;
    return Promise.resolve({ rows: [{ acquired } as unknown as R], rowCount: 1 });
  }

  listen(_channel: string, onNotify: () => void): Promise<void> {
    this.notify = onNotify;
    return Promise.resolve();
  }

  onLost(callback: () => void): void {
    this.lostCallbacks.push(callback);
  }

  /** Simula a queda da conexão de sessão (a trava vai junto). */
  drop(): void {
    this.lost = true;
    if (this.db.lockHolder === this) this.db.lockHolder = null;
    for (const callback of this.lostCallbacks) callback();
  }

  close(): Promise<void> {
    this.lost = true;
    if (this.db.lockHolder === this) this.db.lockHolder = null;
    return Promise.resolve();
  }
}

/** Banco em memória: transação com rollback por cópia; `down` simula o PostgreSQL fora. */
export class MemoryOutboxDatabase implements OutboxDatabase {
  rows: MemoryRow[] = [];
  lockHolder: MemorySession | null = null;
  down = false;
  readonly sessions: MemorySession[] = [];

  transaction<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new Error('connect ECONNREFUSED'));
    const snapshot = this.rows.map((row) => ({ ...row }));
    return work(NO_CLIENT).catch((error: unknown) => {
      this.rows = snapshot;
      throw error;
    });
  }

  openSession(): Promise<RelaySession> {
    if (this.down) return Promise.reject(new Error('connect ECONNREFUSED'));
    const session = new MemorySession(this);
    this.sessions.push(session);
    return Promise.resolve(session);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Repositório sobre o banco em memória (sem SQL). */
export class MemoryOutboxRepository extends OutboxRepository {
  constructor(private readonly db: MemoryOutboxDatabase) {
    super();
  }

  override claimPendingBatch(_client: SqlClient, limit: number): Promise<OutboxRecord[]> {
    const now = Date.now();
    return Promise.resolve(
      this.db.rows
        .filter(
          (row) =>
            row.status === 'PENDING' &&
            (row.next_attempt_at === null || row.next_attempt_at.getTime() <= now),
        )
        .sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime() || (a.id < b.id ? -1 : 1))
        .slice(0, limit)
        .map((row) => ({ ...row })),
    );
  }

  override markPublished(_client: SqlClient, ids: readonly string[]): Promise<number> {
    let count = 0;
    for (const row of this.db.rows) {
      if (ids.includes(row.id) && row.status === 'PENDING') {
        row.status = 'PUBLISHED';
        row.published_at = new Date();
        row.attempts += 1;
        count += 1;
      }
    }
    return Promise.resolve(count);
  }

  override markRetry(
    _client: SqlClient,
    id: string,
    attempts: number,
    nextAttemptAt: Date,
    error: string,
  ): Promise<void> {
    const row = this.db.rows.find((candidate) => candidate.id === id);
    if (row) Object.assign(row, { attempts, next_attempt_at: nextAttemptAt, last_error: error });
    return Promise.resolve();
  }

  override markFailed(
    _client: SqlClient,
    id: string,
    attempts: number,
    error: string,
  ): Promise<void> {
    const row = this.db.rows.find((candidate) => candidate.id === id);
    if (row) Object.assign(row, { status: 'FAILED', attempts, last_error: error });
    return Promise.resolve();
  }
}

/** Fila em memória com deduplicação por `jobId`, como o BullMQ; `down` simula o Redis fora. */
export class MemoryPublisher implements DomainEventsPublisher {
  readonly jobs = new Map<string, PublishableEvent>();
  readonly calls: string[][] = [];
  down = false;

  publish(events: readonly PublishableEvent[]): Promise<void> {
    if (this.down) return Promise.reject(new Error('Connection is closed.'));
    this.calls.push(events.map((event) => event.jobId));
    for (const event of events) if (!this.jobs.has(event.jobId)) this.jobs.set(event.jobId, event);
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
