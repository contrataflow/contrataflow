/*
 * Rascunhos locais do navegador (US-088 · RN-IAM-30/31 · DEC-182): o que foi digitado e ainda não
 * chegou à API fica no IndexedDB, por usuário + instituição. Sobrevive à expiração da sessão por
 * até 24 h e só é oferecido de volta ao mesmo usuário na mesma instituição; quando outro usuário
 * entra no navegador, os rascunhos de terceiros são apagados; no logout, os do próprio usuário.
 * O autosave do editor (US-015) grava e marca como sincronizado; aqui ficam as regras.
 */

/** Retenção dos rascunhos não sincronizados (RN-IAM-30). */
export const DRAFT_TTL_MS = 24 * 3_600_000;

export interface LocalDraft {
  readonly userId: string;
  readonly tenantId: string;
  /** Alvo do rascunho no editor (ex.: `dfd:{id}:JUSTIFICATION`). */
  readonly target: string;
  readonly content: unknown;
  /** Revisão da seção no servidor quando o rascunho começou (conflitos — DEC-182). */
  readonly baseRevision: number | null;
  readonly savedAt: number;
  /** `false` enquanto o conteúdo não foi aceito pela API. */
  readonly synced: boolean;
}

/** Armazenamento dos rascunhos (IndexedDB no navegador; memória nos testes e sem IndexedDB). */
export interface DraftBackend {
  list(): Promise<LocalDraft[]>;
  put(draft: LocalDraft): Promise<void>;
  remove(keys: readonly string[]): Promise<void>;
}

/** Chave única: usuário + instituição + alvo. */
export function draftKey(draft: Pick<LocalDraft, 'userId' | 'tenantId' | 'target'>): string {
  return `${draft.userId}|${draft.tenantId}|${draft.target}`;
}

export class LocalDrafts {
  constructor(
    private readonly backend: DraftBackend,
    private readonly now: () => number = Date.now,
  ) {}

  async save(draft: Omit<LocalDraft, 'savedAt' | 'synced'>): Promise<void> {
    await this.backend.put({ ...draft, savedAt: this.now(), synced: false });
  }

  async markSynced(draft: Pick<LocalDraft, 'userId' | 'tenantId' | 'target'>): Promise<void> {
    const current = (await this.backend.list()).find((item) => draftKey(item) === draftKey(draft));
    if (current) await this.backend.put({ ...current, synced: true });
  }

  /** Rascunhos a oferecer após a nova entrada: mesmo usuário, mesma instituição, < 24 h. */
  async recoverable(userId: string, tenantId: string): Promise<LocalDraft[]> {
    return (await this.live()).filter(
      (draft) => draft.userId === userId && draft.tenantId === tenantId && !draft.synced,
    );
  }

  /** Há o que perder no logout (RN-IAM-31)? */
  async hasUnsynced(userId: string): Promise<boolean> {
    return (await this.live()).some((draft) => draft.userId === userId && !draft.synced);
  }

  /** Logout explícito: apaga os rascunhos do próprio usuário (RN-IAM-31). */
  async clearUser(userId: string): Promise<void> {
    const drafts = await this.backend.list();
    await this.backend.remove(drafts.filter((d) => d.userId === userId).map(draftKey));
  }

  /** Outro usuário entrou no navegador: apaga rascunhos de terceiros e os vencidos (RN-IAM-30). */
  async purgeForeign(userId: string): Promise<void> {
    const limit = this.now() - DRAFT_TTL_MS;
    const drafts = await this.backend.list();
    await this.backend.remove(
      drafts.filter((d) => d.userId !== userId || d.savedAt < limit).map(draftKey),
    );
  }

  private async live(): Promise<LocalDraft[]> {
    const limit = this.now() - DRAFT_TTL_MS;
    return (await this.backend.list()).filter((draft) => draft.savedAt >= limit);
  }
}

export class MemoryDraftBackend implements DraftBackend {
  private readonly drafts = new Map<string, LocalDraft>();

  list(): Promise<LocalDraft[]> {
    return Promise.resolve([...this.drafts.values()]);
  }

  put(draft: LocalDraft): Promise<void> {
    this.drafts.set(draftKey(draft), draft);
    return Promise.resolve();
  }

  remove(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.drafts.delete(key);
    return Promise.resolve();
  }
}

const DATABASE = 'contrataflow-drafts';
const STORE = 'drafts';

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => {
      resolve(operation.result);
    };
    operation.onerror = () => {
      reject(operation.error ?? new Error('IndexedDB'));
    };
  });
}

/** IndexedDB do navegador (um banco por origem; chave = `draftKey`). */
export class IndexedDbDraftBackend implements DraftBackend {
  private database: Promise<IDBDatabase> | undefined;

  constructor(private readonly factory: IDBFactory) {}

  async list(): Promise<LocalDraft[]> {
    const store = await this.store('readonly');
    return request(store.getAll() as IDBRequest<LocalDraft[]>);
  }

  async put(draft: LocalDraft): Promise<void> {
    const store = await this.store('readwrite');
    await request(store.put(draft, draftKey(draft)));
  }

  async remove(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    const store = await this.store('readwrite');
    await Promise.all(keys.map((key) => request(store.delete(key))));
  }

  private async store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    this.database ??= new Promise((resolve, reject) => {
      const open = this.factory.open(DATABASE, 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore(STORE);
      };
      open.onsuccess = () => {
        resolve(open.result);
      };
      open.onerror = () => {
        reject(open.error ?? new Error('IndexedDB'));
      };
    });
    return (await this.database).transaction(STORE, mode).objectStore(STORE);
  }
}

let shared: LocalDrafts | undefined;

/** Rascunhos do navegador (IndexedDB; sem ele — modo privado restrito, testes — em memória). */
export function localDrafts(): LocalDrafts {
  shared ??= new LocalDrafts(
    typeof indexedDB === 'undefined'
      ? new MemoryDraftBackend()
      : new IndexedDbDraftBackend(indexedDB),
  );
  return shared;
}
