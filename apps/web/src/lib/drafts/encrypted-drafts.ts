import { LocalDraftStore, sessionKeyMaterial } from '@contrataflow/ui';
import type { DraftBackend as SealedBackend, StoredDraftRecord } from '@contrataflow/ui';

import { draftKey, localDraftBackend } from './local-drafts';
import type { DraftBackend } from './local-drafts';

/*
 * Contingência cifrada do autosave (US-015 · RN-DFD-33) sobre os rascunhos locais da US-088: o
 * `LocalDraftStore` de `@contrataflow/ui` cifra (AES-GCM, chave da aba no `sessionStorage`) e grava
 * aqui, na mesma chave `cf:{tenantId}:{userId}:{documentId}:{alvo}` — assim o logout (`clearUser`),
 * a entrada de outro usuário (`purgeForeign`), a troca de órgão (`clearTenant`) e o aviso de
 * "alterações não sincronizadas" valem também para o editor. Só o par `iv` + texto cifrado vai
 * para o IndexedDB.
 */

interface SealedContent {
  readonly iv: string;
  readonly data: string;
}

const isSealed = (value: unknown): value is SealedContent =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as SealedContent).iv === 'string' &&
  typeof (value as SealedContent).data === 'string';

/** `cf:{tenant}:{user}:{resto}` → partes (os ids não têm `:`). */
function parseKey(key: string): { tenantId: string; userId: string; target: string } | null {
  const match = /^cf:([^:]+):([^:]+):(.+)$/.exec(key);
  if (!match) return null;
  return { tenantId: match[1] ?? '', userId: match[2] ?? '', target: match[3] ?? '' };
}

/** Os rascunhos da US-088 vistos como o armazenamento bruto do `LocalDraftStore`. */
export class SealedDraftBackend implements SealedBackend {
  constructor(private readonly drafts: DraftBackend) {}

  async get(key: string): Promise<StoredDraftRecord | undefined> {
    const found = (await this.drafts.list()).find((draft) => draftKey(draft) === key);
    if (found === undefined || !isSealed(found.content)) return undefined;
    return { key, iv: found.content.iv, data: found.content.data, savedAt: found.savedAt };
  }

  async put(record: StoredDraftRecord): Promise<void> {
    const parts = parseKey(record.key);
    if (parts === null) throw new Error(`Chave de rascunho inválida: ${record.key}`);
    await this.drafts.put({
      ...parts,
      content: { iv: record.iv, data: record.data },
      baseRevision: null,
      savedAt: record.savedAt,
      synced: false,
    });
  }

  delete(key: string): Promise<void> {
    return this.drafts.remove([key]);
  }

  async keys(prefix: string): Promise<string[]> {
    return (await this.drafts.list()).map(draftKey).filter((key) => key.startsWith(prefix));
  }
}

let shared: LocalDraftStore | undefined;

/** A contingência do editor neste navegador (uma por aba). */
export function editorDraftStore(): LocalDraftStore {
  shared ??= new LocalDraftStore({
    backend: new SealedDraftBackend(localDraftBackend()),
    keyMaterial: sessionKeyMaterial(
      typeof sessionStorage === 'undefined' ? undefined : sessionStorage,
    ),
  });
  return shared;
}
