/*
 * Contingência local do autosave (US-015 · RN-DFD-33 · DEC-182): guarda SOMENTE as alterações
 * pendentes ou com falha, na chave `cf:{tenantId}:{userId}:{documentId}:{alvo}`, com a revisão-base
 * do servidor. O conteúdo é cifrado com AES-GCM por uma chave NÃO exportável derivada de um material
 * aleatório guardado no `sessionStorage` da aba: recarregar a aba (ou voltar do login na mesma aba)
 * restaura; fechar a aba apaga o material — o rascunho fica ilegível e é descartado no próximo
 * início (computador compartilhado). Validade de 24 h. Apagado depois da gravação confirmada, no
 * logout e na troca de órgão (`clear`). Quem chama nunca guarda campos mascarados por POL-09.
 */

/** Registro persistido (o valor só cifrado). */
export interface StoredDraftRecord {
  readonly key: string;
  readonly iv: string;
  readonly data: string;
  readonly savedAt: number;
}

/** Armazenamento bruto (IndexedDB no navegador; memória nos testes). */
export interface DraftBackend {
  get(key: string): Promise<StoredDraftRecord | undefined>;
  put(record: StoredDraftRecord): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
}

/** O que a contingência guarda de cada alvo. */
export interface LocalDraft<V> {
  /** Revisão/ETag do servidor sobre a qual a alteração foi feita (FA-08). */
  readonly base: string;
  readonly value: V;
  readonly savedAt: number;
}

export interface DraftScope {
  readonly tenantId: string;
  readonly userId: string;
  readonly documentId: string;
}

/** Validade da pendência local (RN-DFD-33). */
export const LOCAL_DRAFT_TTL_MS = 24 * 3_600_000;

const SESSION_KEY = 'cf:autosave:key';

export function draftKey(scope: DraftScope, target?: string): string {
  const base = `cf:${scope.tenantId}:${scope.userId}:${scope.documentId}:`;
  return target === undefined ? base : `${base}${target}`;
}

/** Base64 em blocos (uma seção chega a 1 MB: espalhar tudo em `fromCharCode` estoura a pilha). */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}
const fromBase64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

/** Material da chave da aba no `sessionStorage` (criado na primeira vez). */
export interface KeyMaterialSource {
  get(): string | null;
  set(value: string): void;
}

export const sessionKeyMaterial = (storage: Storage | undefined): KeyMaterialSource => ({
  get: () => {
    try {
      return storage?.getItem(SESSION_KEY) ?? null;
    } catch {
      return null;
    }
  },
  set: (value) => {
    try {
      storage?.setItem(SESSION_KEY, value);
    } catch {
      // Sem sessionStorage (modo privado restrito): a chave vive só nesta página.
    }
  },
});

export interface LocalDraftStoreOptions {
  readonly backend: DraftBackend;
  readonly keyMaterial: KeyMaterialSource;
  readonly crypto?: Crypto;
  readonly now?: () => number;
}

export class LocalDraftStore {
  private keyPromise: Promise<CryptoKey> | null = null;
  private readonly crypto: Crypto;
  private readonly now: () => number;

  constructor(private readonly options: LocalDraftStoreOptions) {
    this.crypto = options.crypto ?? globalThis.crypto;
    this.now = options.now ?? (() => Date.now());
  }

  /** Chave AES-GCM não exportável derivada do material da aba. */
  private key(): Promise<CryptoKey> {
    this.keyPromise ??= (async () => {
      let material = this.options.keyMaterial.get();
      if (material === null) {
        material = toBase64(this.crypto.getRandomValues(new Uint8Array(32)));
        this.options.keyMaterial.set(material);
      }
      return this.crypto.subtle.importKey('raw', fromBase64(material), 'AES-GCM', false, [
        'encrypt',
        'decrypt',
      ]);
    })();
    return this.keyPromise;
  }

  async save<V>(scope: DraftScope, target: string, draft: Omit<LocalDraft<V>, 'savedAt'>) {
    const iv = this.crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(
      JSON.stringify({ base: draft.base, value: draft.value }),
    );
    const cipher = await this.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      await this.key(),
      plain,
    );
    await this.options.backend.put({
      key: draftKey(scope, target),
      iv: toBase64(iv),
      data: toBase64(new Uint8Array(cipher)),
      savedAt: this.now(),
    });
  }

  /**
   * A pendência do alvo, ou `null` — vencida (24 h) ou ilegível (aba fechada: outra chave) é
   * apagada aqui.
   */
  async load<V>(scope: DraftScope, target: string): Promise<LocalDraft<V> | null> {
    const key = draftKey(scope, target);
    const record = await this.options.backend.get(key);
    if (record === undefined) return null;
    if (this.now() - record.savedAt > LOCAL_DRAFT_TTL_MS) {
      await this.options.backend.delete(key);
      return null;
    }
    try {
      const plain = await this.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(record.iv) },
        await this.key(),
        fromBase64(record.data),
      );
      const parsed = JSON.parse(new TextDecoder().decode(plain)) as { base: string; value: V };
      return { base: parsed.base, value: parsed.value, savedAt: record.savedAt };
    } catch {
      await this.options.backend.delete(key);
      return null;
    }
  }

  /** Todas as pendências legíveis do documento (a faixa "Recuperamos alterações não salvas"). */
  async loadAll<V>(scope: DraftScope): Promise<Record<string, LocalDraft<V>>> {
    const prefix = draftKey(scope);
    const drafts: Record<string, LocalDraft<V>> = {};
    for (const key of await this.options.backend.keys(prefix)) {
      const target = key.slice(prefix.length);
      const draft = await this.load<V>(scope, target);
      if (draft !== null) drafts[target] = draft;
    }
    return drafts;
  }

  remove(scope: DraftScope, target: string): Promise<void> {
    return this.options.backend.delete(draftKey(scope, target));
  }

  /** Logout e troca de órgão: apaga tudo do prefixo (`cf:` = tudo; `cf:{tenant}:` = o órgão). */
  async clear(prefix = 'cf:'): Promise<void> {
    for (const key of await this.options.backend.keys(prefix)) {
      await this.options.backend.delete(key);
    }
  }
}

/** Armazenamento em memória (testes e navegador sem IndexedDB). */
export class MemoryDraftBackend implements DraftBackend {
  readonly records = new Map<string, StoredDraftRecord>();

  get(key: string): Promise<StoredDraftRecord | undefined> {
    return Promise.resolve(this.records.get(key));
  }

  put(record: StoredDraftRecord): Promise<void> {
    this.records.set(record.key, record);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.records.delete(key);
    return Promise.resolve();
  }

  keys(prefix: string): Promise<string[]> {
    return Promise.resolve([...this.records.keys()].filter((key) => key.startsWith(prefix)));
  }
}

const DB_NAME = 'contrataflow-autosave';
const STORE = 'drafts';

/** IndexedDB (`contrataflow-autosave`/`drafts`, chave = `key`). */
export class IndexedDbDraftBackend implements DraftBackend {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly factory: IDBFactory) {}

  private db(): Promise<IDBDatabase> {
    this.dbPromise ??= new Promise((resolve, reject) => {
      const request = this.factory.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE, { keyPath: 'key' });
      };
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(request.error ?? new Error('IndexedDB indisponível.'));
      };
    });
    return this.dbPromise;
  }

  private async request<T>(
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = work(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(request.error ?? new Error('IndexedDB: falha na operação.'));
      };
    });
  }

  get(key: string): Promise<StoredDraftRecord | undefined> {
    return this.request('readonly', (store) => store.get(key) as IDBRequest<StoredDraftRecord>);
  }

  async put(record: StoredDraftRecord): Promise<void> {
    await this.request('readwrite', (store) => store.put(record));
  }

  async delete(key: string): Promise<void> {
    await this.request('readwrite', (store) => store.delete(key));
  }

  async keys(prefix: string): Promise<string[]> {
    const all = await this.request('readonly', (store) => store.getAllKeys());
    return all.map(String).filter((key) => key.startsWith(prefix));
  }
}

/** A contingência do navegador: IndexedDB se houver (senão memória) e a chave da aba. */
export function browserDraftStore(): LocalDraftStore {
  const backend =
    typeof indexedDB === 'undefined'
      ? new MemoryDraftBackend()
      : new IndexedDbDraftBackend(indexedDB);
  return new LocalDraftStore({
    backend,
    keyMaterial: sessionKeyMaterial(
      typeof sessionStorage === 'undefined' ? undefined : sessionStorage,
    ),
  });
}
