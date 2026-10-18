// @vitest-environment jsdom
import { LocalDraftStore } from '@contrataflow/ui';
import type { KeyMaterialSource } from '@contrataflow/ui';
import { describe, expect, it } from 'vitest';

import { SealedDraftBackend } from './encrypted-drafts';
import { LocalDrafts, MemoryDraftBackend } from './local-drafts';

/*
 * US-015 · RN-DFD-33: a contingência cifrada do autosave grava nos rascunhos da US-088 — a mesma
 * chave `cf:{tenant}:{usuário}:{documento}:{alvo}` —, então logout, entrada de outro usuário e troca
 * de órgão também a apagam; o IndexedDB só recebe o texto cifrado.
 */

const keyMaterial = (): KeyMaterialSource => {
  let value: string | null = null;
  return {
    get: () => value,
    set: (next) => {
      value = next;
    },
  };
};

const scope = { tenantId: 't-a', userId: 'u-ana', documentId: 'doc-1' };

describe('SealedDraftBackend (US-015 sobre US-088)', () => {
  it('grava cifrado na chave da US-088, lê de volta e lista por prefixo', async () => {
    const raw = new MemoryDraftBackend();
    const store = new LocalDraftStore({
      backend: new SealedDraftBackend(raw),
      keyMaterial: keyMaterial(),
    });
    await store.save(scope, 'SECTION:JUSTIFICATION', { base: 's3', value: 'texto sigiloso' });
    const [draft] = await raw.list();
    expect(draft).toMatchObject({
      tenantId: 't-a',
      userId: 'u-ana',
      target: 'doc-1:SECTION:JUSTIFICATION',
      synced: false,
    });
    expect(JSON.stringify(draft)).not.toContain('texto sigiloso');
    expect(await store.loadAll(scope)).toEqual({
      'SECTION:JUSTIFICATION': {
        base: 's3',
        value: 'texto sigiloso',
        savedAt: expect.any(Number) as number,
      },
    });
    // O aviso de "alterações não sincronizadas" do logout (RN-IAM-31) enxerga a pendência.
    expect(await new LocalDrafts(raw).hasUnsynced('u-ana')).toBe(true);
    await store.remove(scope, 'SECTION:JUSTIFICATION');
    expect(await raw.list()).toEqual([]);
  });

  it('logout (clearUser) e troca de órgão (clearTenant) apagam a contingência', async () => {
    const raw = new MemoryDraftBackend();
    const store = new LocalDraftStore({
      backend: new SealedDraftBackend(raw),
      keyMaterial: keyMaterial(),
    });
    await store.save(scope, 'HEADER', { base: '8', value: { priority: 'HIGH' } });
    await store.save({ ...scope, tenantId: 't-b' }, 'HEADER', { base: '1', value: {} });
    const drafts = new LocalDrafts(raw);
    await drafts.clearTenant('t-a');
    expect((await raw.list()).map((draft) => draft.tenantId)).toEqual(['t-b']);
    await drafts.clearUser('u-ana');
    expect(await raw.list()).toEqual([]);
  });

  it('ignora rascunhos que não são da contingência e recusa chave inválida', async () => {
    const raw = new MemoryDraftBackend();
    await raw.put({
      tenantId: 't-a',
      userId: 'u-ana',
      target: 'doc-1:OTHER',
      content: 'texto antigo',
      baseRevision: null,
      savedAt: 0,
      synced: false,
    });
    const backend = new SealedDraftBackend(raw);
    expect(await backend.get('cf:t-a:u-ana:doc-1:OTHER')).toBeUndefined();
    await expect(backend.put({ key: 'invalida', iv: 'a', data: 'b', savedAt: 0 })).rejects.toThrow(
      'Chave de rascunho inválida',
    );
  });
});
