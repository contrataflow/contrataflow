import { webcrypto } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  LOCAL_DRAFT_TTL_MS,
  LocalDraftStore,
  MemoryDraftBackend,
  draftKey,
  sessionKeyMaterial,
} from './local-draft-store.js';
import type { KeyMaterialSource } from './local-draft-store.js';

const scope = { tenantId: 't1', userId: 'u1', documentId: 'd1' };
const crypto = webcrypto as unknown as Crypto;

function material(): KeyMaterialSource & { value: string | null } {
  return {
    value: null,
    get() {
      return this.value;
    },
    set(value: string) {
      this.value = value;
    },
  };
}

describe('LocalDraftStore (US-015 · RN-DFD-33)', () => {
  it('chave cf:{tenant}:{usuário}:{documento}:{alvo}; conteúdo cifrado (nunca em claro)', async () => {
    const backend = new MemoryDraftBackend();
    const store = new LocalDraftStore({ backend, keyMaterial: material(), crypto });
    await store.save(scope, 'SECTION:JUSTIFICATION', { base: 's3', value: { text: 'segredo' } });
    expect(draftKey(scope, 'SECTION:JUSTIFICATION')).toBe('cf:t1:u1:d1:SECTION:JUSTIFICATION');
    const [record] = [...backend.records.values()];
    expect(record?.key).toBe('cf:t1:u1:d1:SECTION:JUSTIFICATION');
    expect(JSON.stringify(record)).not.toContain('segredo');
    expect(await store.load(scope, 'SECTION:JUSTIFICATION')).toMatchObject({
      base: 's3',
      value: { text: 'segredo' },
    });
  });

  it('mesma aba (mesmo material no sessionStorage) restaura depois da recarga', async () => {
    const backend = new MemoryDraftBackend();
    const keys = material();
    await new LocalDraftStore({ backend, keyMaterial: keys, crypto }).save(scope, 'HEADER', {
      base: '8',
      value: { priority: 'HIGH' },
    });
    const reloaded = new LocalDraftStore({ backend, keyMaterial: keys, crypto });
    expect(await reloaded.loadAll(scope)).toEqual({
      HEADER: { base: '8', value: { priority: 'HIGH' }, savedAt: expect.any(Number) as number },
    });
  });

  it('aba fechada (outro material): ilegível e descartado no próximo início', async () => {
    const backend = new MemoryDraftBackend();
    await new LocalDraftStore({ backend, keyMaterial: material(), crypto }).save(scope, 'HEADER', {
      base: '1',
      value: 'x',
    });
    const otherTab = new LocalDraftStore({ backend, keyMaterial: material(), crypto });
    expect(await otherTab.load(scope, 'HEADER')).toBeNull();
    expect(backend.records.size).toBe(0);
  });

  it('validade de 24 h; remove e clear (logout / troca de órgão)', async () => {
    let now = 0;
    const backend = new MemoryDraftBackend();
    const store = new LocalDraftStore({
      backend,
      keyMaterial: material(),
      crypto,
      now: () => now,
    });
    await store.save(scope, 'A', { base: '1', value: 'a' });
    now = LOCAL_DRAFT_TTL_MS + 1;
    expect(await store.load(scope, 'A')).toBeNull();
    await store.save(scope, 'B', { base: '1', value: 'b' });
    await store.save({ ...scope, tenantId: 't2' }, 'C', { base: '1', value: 'c' });
    await store.remove(scope, 'B');
    expect(await store.load(scope, 'B')).toBeNull();
    await store.clear('cf:t2:');
    expect(backend.records.size).toBe(0);
  });

  it('cifra conteúdo de 1 MB (base64 em blocos)', async () => {
    const store = new LocalDraftStore({
      backend: new MemoryDraftBackend(),
      keyMaterial: material(),
      crypto,
    });
    const big = 'x'.repeat(1024 * 1024);
    await store.save(scope, 'BIG', { base: '1', value: big });
    expect((await store.load<string>(scope, 'BIG'))?.value).toHaveLength(big.length);
  });

  it('sessionKeyMaterial tolera sessionStorage indisponível', () => {
    const source = sessionKeyMaterial(undefined);
    expect(source.get()).toBeNull();
    expect(() => {
      source.set('x');
    }).not.toThrow();
    sessionStorage.clear();
    const real = sessionKeyMaterial(sessionStorage);
    real.set('abc');
    expect(real.get()).toBe('abc');
  });
});
