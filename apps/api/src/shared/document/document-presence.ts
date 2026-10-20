/*
 * Presença de edição no documento (US-070 · DEC-055 · RN-DOC-88..93): dado efêmero, fora do
 * PostgreSQL — um conjunto ordenado por documento (`userId` → último heartbeat) e a seção em foco de
 * cada um, ambos com TTL. Porta do shared kernel: o módulo `document` usa, a `platform` implementa
 * no Redis principal (único lugar com cliente Redis — RM-03). Quem chama trata o erro do
 * armazenamento como indisponibilidade (fail-open — RN-DOC-92).
 */

/** Uma presença gravada (já podada das expiradas pelo armazenamento). */
export interface DocumentPresenceEntry {
  readonly userId: string;
  /** Seção em foco (`null` = nenhuma informada até agora). */
  readonly sectionKey: string | null;
  /** Desde quando está nessa seção (muda ao trocar de seção, não a cada heartbeat). */
  readonly since: Date;
  /** Último heartbeat. */
  readonly lastSeenAt: Date;
}

export interface DocumentPresenceKey {
  readonly tenantId: string;
  readonly documentId: string;
}

export interface DocumentPresenceTouch extends DocumentPresenceKey {
  readonly userId: string;
  /** Nova seção em foco; `null` mantém a anterior (heartbeat sem seção ou seção inválida — V-01). */
  readonly sectionKey: string | null;
  readonly now: Date;
  readonly ttlMs: number;
}

export interface DocumentPresenceStorePort {
  /**
   * Numa operação atômica: poda as presenças sem heartbeat há `ttlMs`, grava/renova a do usuário
   * (uma entrada por usuário — Duplicidade) e renova o TTL; devolve todas as presenças ativas,
   * inclusive a do próprio chamador.
   */
  touch(input: DocumentPresenceTouch): Promise<readonly DocumentPresenceEntry[]>;
  /** Encerra a presença do usuário (DOC-25) — idempotente. */
  remove(input: DocumentPresenceKey & { readonly userId: string }): Promise<void>;
}

export const DOCUMENT_PRESENCE_STORE = Symbol('DocumentPresenceStorePort');

interface StoredPresence {
  sectionKey: string | null;
  since: number;
  lastSeenAt: number;
}

/** Implementação em memória (testes e identidade fake), com a mesma semântica do Redis. */
export class InMemoryDocumentPresenceStore implements DocumentPresenceStorePort {
  private readonly documents = new Map<string, Map<string, StoredPresence>>();
  /** Simula o Redis fora do ar (Falha de banco — RN-DOC-92). */
  down = false;

  private static keyOf(key: DocumentPresenceKey): string {
    return `${key.tenantId}|${key.documentId}`;
  }

  touch(input: DocumentPresenceTouch): Promise<readonly DocumentPresenceEntry[]> {
    if (this.down) return Promise.reject(new Error('presence store unavailable'));
    const now = input.now.getTime();
    const key = InMemoryDocumentPresenceStore.keyOf(input);
    const users = this.documents.get(key) ?? new Map<string, StoredPresence>();
    for (const [userId, presence] of users) {
      if (presence.lastSeenAt <= now - input.ttlMs) users.delete(userId);
    }
    const previous = users.get(input.userId);
    const sectionKey = input.sectionKey ?? previous?.sectionKey ?? null;
    const since = previous?.sectionKey === sectionKey ? previous.since : now;
    users.set(input.userId, { sectionKey, since, lastSeenAt: now });
    this.documents.set(key, users);
    return Promise.resolve(
      [...users].map(([userId, presence]) => ({
        userId,
        sectionKey: presence.sectionKey,
        since: new Date(presence.since),
        lastSeenAt: new Date(presence.lastSeenAt),
      })),
    );
  }

  remove(input: DocumentPresenceKey & { readonly userId: string }): Promise<void> {
    if (this.down) return Promise.reject(new Error('presence store unavailable'));
    this.documents.get(InMemoryDocumentPresenceStore.keyOf(input))?.delete(input.userId);
    return Promise.resolve();
  }

  /** Testes: usuários com presença gravada no documento (sem podar). */
  usersOf(key: DocumentPresenceKey): readonly string[] {
    return [...(this.documents.get(InMemoryDocumentPresenceStore.keyOf(key))?.keys() ?? [])];
  }
}
