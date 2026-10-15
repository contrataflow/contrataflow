import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { InMemoryCacheStore } from '#shared/cache/cache-store.js';
import { TenantCache } from '#shared/cache/tenant-cache.js';
import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { DOCUMENT_TYPES_CACHE_TTL_SECONDS, DocumentTypeFacade } from './document-type.facade.js';
import { testConfig } from '../../../../test/support/api-test-app.js';
import { buildSystemDocumentTypes } from '../domain/system-document-types.js';
import {
  InMemoryDocumentTransactions,
  InMemoryDocumentTypeRepository,
} from '../infrastructure/in-memory-document-type.repository.js';

const A = '0192f000-0000-7000-8000-00000000061a';
const B = '0192f000-0000-7000-8000-00000000061b';
const NOW = new Date('2026-10-15T12:00:00.000Z');
const tx = {} as TenantTx;

function setup() {
  const repository = new InMemoryDocumentTypeRepository();
  const store = new InMemoryCacheStore();
  const facade = new DocumentTypeFacade(
    repository,
    new InMemoryDocumentTransactions(),
    () => NOW,
    new TenantCache(store, testConfig()),
  );
  const asTenant = <T>(tenantId: string, fn: () => Promise<T>): Promise<T> =>
    runWithRequestContext({ correlationId: 'c', ip: '', userAgent: '' }, () => {
      updateRequestContext({ tenantId });
      return fn();
    });
  return { repository, store, facade, asTenant };
}

async function thrown(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('não lançou');
}

describe('DocumentTypeFacade (núcleo antecipado da US-061)', () => {
  it('seedDefaults semeia os 11 tipos do tenant do contexto, uma única vez', async () => {
    const { facade, repository, asTenant } = setup();
    expect(await asTenant(A, () => facade.seedDefaults(tx))).toBe(11);
    expect(await asTenant(A, () => facade.seedDefaults(tx))).toBe(0);
    expect(await asTenant(B, () => facade.seedDefaults(tx))).toBe(11);
    expect(repository.snapshot()).toHaveLength(22);
    expect(repository.snapshot().filter((type) => type.tenantId === A)).toHaveLength(11);
  });

  it('listActive/getByCode/getById leem o catálogo do tenant do contexto', async () => {
    const { facade, repository, asTenant } = setup();
    await asTenant(A, () => facade.seedDefaults(tx));
    await asTenant(B, () => facade.seedDefaults(tx));
    const oficioB = repository.snapshot().find((t) => t.tenantId === B && t.code === 'OFICIO');

    const active = await asTenant(A, () => facade.listActive());
    expect(active).toHaveLength(11);
    expect(active[0]?.code).toBe('DFD');
    const oficio = await asTenant(A, () => facade.getByCode('OFICIO'));
    expect(oficio).toMatchObject({ tenantId: A, code: 'OFICIO', isSystem: true });
    expect(await asTenant(A, () => facade.getByCode('NAO_EXISTE'))).toBeNull();
    // Id de outro tenant não é encontrado.
    expect(await asTenant(A, () => facade.getById(oficioB?.id ?? ''))).toBeNull();
    expect(await asTenant(B, () => facade.getById(oficioB?.id ?? ''))).toMatchObject({
      tenantId: B,
    });
  });

  it('assertCreatable: existente e ativo passa; inexistente/outro tenant e inativo → 422 em documentTypeId', async () => {
    const { facade, repository, asTenant } = setup();
    await asTenant(A, () => facade.seedDefaults(tx));
    await asTenant(B, () => facade.seedDefaults(tx));
    const find = (tenantId: string, code: string) =>
      repository.snapshot().find((t) => t.tenantId === tenantId && t.code === code);
    const despacho = find(A, 'DESPACHO');
    if (!despacho) throw new Error('DESPACHO não semeado');
    repository.seed({ ...despacho, isActive: false });

    await expect(
      asTenant(A, () => facade.assertCreatable(find(A, 'OFICIO')?.id ?? '')),
    ).resolves.toMatchObject({ code: 'OFICIO' });
    const other = await thrown(
      asTenant(A, () => facade.assertCreatable(find(B, 'OFICIO')?.id ?? '')),
    );
    expect(other).toMatchObject({ code: 'VALIDATION_ERROR', status: 422 });
    expect(other.errors).toEqual([
      expect.objectContaining({ field: 'documentTypeId', code: 'REFERENCE_NOT_FOUND' }),
    ]);
    const off = await thrown(
      asTenant(A, () => facade.assertCreatable(find(A, 'DESPACHO')?.id ?? '')),
    );
    expect(off.errors).toEqual([
      expect.objectContaining({ field: 'documentTypeId', code: 'REFERENCE_INACTIVE' }),
    ]);
  });

  describe('cache por tenant (RN-DOC-12)', () => {
    it('a segunda leitura vem do cache (TTL de 10 min) e o cache é por tenant', async () => {
      const { facade, repository, store, asTenant } = setup();
      await asTenant(A, () => facade.seedDefaults(tx));
      const list = vi.spyOn(repository, 'list');

      await asTenant(A, () => facade.listAll());
      await asTenant(A, () => facade.listAll());
      expect(list).toHaveBeenCalledTimes(1);

      const keys = [...store.entries.keys()];
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatch(new RegExp(`^cf:test:t:${A}:document:types$`));
      const ttl = ((store.entries.get(keys[0] ?? '')?.expiresAt ?? 0) - Date.now()) / 1000;
      expect(ttl).toBeLessThanOrEqual(DOCUMENT_TYPES_CACHE_TTL_SECONDS);
      expect(ttl).toBeGreaterThan(DOCUMENT_TYPES_CACHE_TTL_SECONDS - 5);

      await asTenant(B, () => facade.listAll());
      expect(list).toHaveBeenCalledTimes(2);
      expect(store.entries.size).toBe(2);
    });

    it('invalidate apaga só a chave do tenant do contexto', async () => {
      const { facade, store, asTenant } = setup();
      await asTenant(A, () => facade.listAll());
      await asTenant(B, () => facade.listAll());
      await asTenant(A, () => facade.invalidate());
      expect([...store.entries.keys()]).toEqual([expect.stringContaining(B)]);
    });

    it('valor corrompido no cache vira ausência: recarrega do banco', async () => {
      const { facade, repository, store, asTenant } = setup();
      await asTenant(A, () => facade.seedDefaults(tx));
      await asTenant(A, () => facade.listAll());
      const [key] = [...store.entries.keys()];
      await store.set(key ?? '', '{"não":"é uma lista"}', 60);
      expect(await asTenant(A, () => facade.listAll())).toHaveLength(11);
      expect(repository.snapshot()).toHaveLength(11);
    });

    it('cache indisponível: lê do banco, não falha e a invalidação só registra aviso', async () => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { facade, store, asTenant } = setup();
      await asTenant(A, () => facade.seedDefaults(tx));
      vi.spyOn(store, 'get').mockRejectedValue(new Error('redis fora'));
      vi.spyOn(store, 'delete').mockRejectedValue(new Error('redis fora'));
      expect(await asTenant(A, () => facade.listAll())).toHaveLength(11);
      await expect(asTenant(A, () => facade.invalidate())).resolves.toBeUndefined();
    });

    it('as datas voltam do cache como Date', async () => {
      const { facade, asTenant } = setup();
      await asTenant(A, () => facade.seedDefaults(tx));
      await asTenant(A, () => facade.listAll());
      const [first] = await asTenant(A, () => facade.listAll());
      expect(first?.createdAt).toBeInstanceOf(Date);
      expect(first?.createdAt.toISOString()).toBe(NOW.toISOString());
      expect(buildSystemDocumentTypes(A, NOW, newId)[0]?.code).toBe(first?.code);
    });
  });
});
