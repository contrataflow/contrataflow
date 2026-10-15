import 'server-only';

import { randomUUID } from 'node:crypto';

import { DEFAULT_SESSION_POLICY } from '@contrataflow/types';
import type { SessionTombstone } from '@contrataflow/validation';

import type { SessionEnding, SessionRecord, SessionStore } from './types';

/**
 * Store de sessões em memória do processo — só local/dev/test (uma réplica). Com mais de uma
 * réplica, e sempre em staging/produção, o BFF usa o Redis de sessões (DEC-131 · US-087). Mesma
 * semântica do Redis: atualização não recria sessão encerrada e o encerramento deixa um registro
 * sem tokens (aqui só para consulta — não há varredura nem auditoria em memória).
 */
export class MemorySessionStore implements SessionStore {
  private readonly records = new Map<string, SessionRecord>();
  private readonly ended = new Map<string, SessionTombstone>();
  private readonly locks = new Map<string, { owner: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  get(key: string): Promise<SessionRecord | null> {
    return Promise.resolve(this.records.get(key) ?? null);
  }

  save(record: SessionRecord): Promise<void> {
    if (this.records.has(record.key)) this.records.set(record.key, record);
    return Promise.resolve();
  }

  async create(record: SessionRecord, maxPerUser: number): Promise<readonly string[]> {
    this.records.set(record.key, record);
    const sessions = this.byUser(record.userId).sort(
      (left, right) => left.createdAt - right.createdAt,
    );
    const evicted = sessions.slice(0, Math.max(0, sessions.length - maxPerUser));
    for (const old of evicted) {
      await this.end(old, {
        reason: 'SESSION_LIMIT',
        occurredAt: this.now(),
        ip: null,
        userAgent: null,
      });
    }
    return evicted.map((session) => session.key);
  }

  reindex(): Promise<void> {
    return Promise.resolve();
  }

  end(record: SessionRecord, ending: SessionEnding): Promise<boolean> {
    this.records.delete(record.key);
    if (this.ended.has(record.key)) return Promise.resolve(false);
    this.ended.set(record.key, {
      key: record.key,
      userId: record.userId,
      displayName: record.displayName,
      activeTenantId: record.activeTenantId,
      membershipId: record.membershipId,
      reason: ending.reason,
      occurredAt: ending.occurredAt,
      createdAt: record.createdAt,
      lastSeenAt: record.lastSeenAt,
      idleMinutes: record.idleMinutes || DEFAULT_SESSION_POLICY.idleMinutes,
      ip: ending.ip,
      userAgent: ending.userAgent,
    });
    return Promise.resolve(true);
  }

  getEnded(key: string): Promise<SessionTombstone | null> {
    return Promise.resolve(this.ended.get(key) ?? null);
  }

  acquireRefreshLock(key: string, ttlMs: number): Promise<string | null> {
    const current = this.locks.get(key);
    if (current && current.expiresAt > this.now()) return Promise.resolve(null);
    const owner = randomUUID();
    this.locks.set(key, { owner, expiresAt: this.now() + ttlMs });
    return Promise.resolve(owner);
  }

  releaseRefreshLock(key: string, owner: string): Promise<void> {
    if (this.locks.get(key)?.owner === owner) this.locks.delete(key);
    return Promise.resolve();
  }

  /** Quantidade de sessões vivas (testes). */
  get size(): number {
    return this.records.size;
  }

  /** Sessões vivas de um usuário (testes). */
  byUser(userId: string): SessionRecord[] {
    return [...this.records.values()].filter((record) => record.userId === userId);
  }

  /** Registros de encerramento (testes). */
  endings(): SessionTombstone[] {
    return [...this.ended.values()];
  }
}
