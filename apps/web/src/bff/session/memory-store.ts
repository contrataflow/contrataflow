import 'server-only';

import type { SessionRecord, SessionStore } from './types';

/**
 * Store de sessões em memória do processo — só desenvolvimento e testes (uma réplica). A US-087
 * troca pelo Redis de sessões (DEC-131), obrigatório com mais de uma réplica.
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

  delete(key: string): Promise<void> {
    this.records.delete(key);
    return Promise.resolve();
  }

  /** Quantidade de sessões (testes). */
  get size(): number {
    return this.records.size;
  }
}
