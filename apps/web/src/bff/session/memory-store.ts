import 'server-only';

import type { SessionRecord, SessionStore } from './types';

/**
 * Store de sessões em memória do processo — só local/dev/test (uma réplica). Com mais de uma
 * réplica, e sempre em staging/produção, o BFF usa o Redis de sessões (DEC-131 · US-087).
 */
export class MemorySessionStore implements SessionStore {
  private readonly records = new Map<string, SessionRecord>();

  get(key: string): Promise<SessionRecord | null> {
    return Promise.resolve(this.records.get(key) ?? null);
  }

  save(record: SessionRecord): Promise<void> {
    this.records.set(record.key, record);
    return Promise.resolve();
  }

  create(record: SessionRecord, maxPerUser: number): Promise<readonly string[]> {
    this.records.set(record.key, record);
    const sessions = [...this.records.values()]
      .filter((candidate) => candidate.userId === record.userId)
      .sort((left, right) => left.createdAt - right.createdAt);
    const evicted = sessions.slice(0, Math.max(0, sessions.length - maxPerUser)).map((s) => s.key);
    for (const key of evicted) this.records.delete(key);
    return Promise.resolve(evicted);
  }

  delete(key: string): Promise<void> {
    this.records.delete(key);
    return Promise.resolve();
  }

  /** Quantidade de sessões (testes). */
  get size(): number {
    return this.records.size;
  }

  /** Sessões de um usuário (testes). */
  byUser(userId: string): SessionRecord[] {
    return [...this.records.values()].filter((record) => record.userId === userId);
  }
}
