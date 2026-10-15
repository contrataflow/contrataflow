import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';

import { assertTenantStorageKey, StorageKeyBuilder, StorageKeyError } from './storage-keys.js';
import {
  MAX_PRESIGN_SECONDS,
  PresignExpiryError,
  StorageNotConfiguredError,
  StorageService,
  UnconfiguredObjectStorage,
} from './storage.service.js';
import type { ObjectStorage, PresignedRequest } from './storage.service.js';
import { TenantContextMissingError, TenantIsolationViolationError } from '../tenancy/isolation.js';

const A = '0192a000-0000-7000-8000-00000000000a';
const B = '0192a000-0000-7000-8000-00000000000b';
const PROCESS = '0192a000-0000-7000-8000-0000000000f1';
const DOCUMENT = '0192a000-0000-7000-8000-0000000000f2';

function inTenant<T>(tenantId: string | null, fn: () => T): T {
  return runWithRequestContext({ correlationId: 'corr-storage', ip: '', userAgent: '' }, () => {
    if (tenantId !== null) updateRequestContext({ tenantId });
    return fn();
  });
}

function fakeStorage() {
  const signed: PresignedRequest = {
    url: 'https://s3.test/assinada',
    method: 'GET',
    headers: {},
    expiresAt: new Date(0),
  };
  return {
    presignGet: vi.fn(() => Promise.resolve(signed)),
    presignPut: vi.fn(() => Promise.resolve({ ...signed, method: 'PUT' as const })),
  } satisfies ObjectStorage;
}

let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StorageKeyBuilder (RN-TEN-30 · storage.md §4)', () => {
  it('monta as chaves do layout sempre com o tenant do contexto', () => {
    inTenant(A, () => {
      expect(StorageKeyBuilder.quarantine('att-1')).toBe(`tenants/${A}/uploads/att-1`);
      expect(StorageKeyBuilder.processAttachment(PROCESS, 'att-1', 'etp.pdf')).toBe(
        `tenants/${A}/processes/${PROCESS}/attachments/att-1/etp.pdf`,
      );
      expect(StorageKeyBuilder.versionContent(PROCESS, DOCUMENT, 3)).toBe(
        `tenants/${A}/processes/${PROCESS}/documents/${DOCUMENT}/versions/3/renditions/content.pdf`,
      );
    });
  });

  it('sem contexto falha fechado; segmento com barra, "..", espaço ou vazio é recusado', () => {
    expect(() => inTenant(null, () => StorageKeyBuilder.quarantine('att-1'))).toThrow(
      TenantContextMissingError,
    );
    inTenant(A, () => {
      for (const bad of ['a/b', '..', 'a..b', 'com espaço', '', '.oculto']) {
        expect(() => StorageKeyBuilder.build('uploads', bad)).toThrow(StorageKeyError);
      }
      expect(() => StorageKeyBuilder.build()).toThrow(StorageKeyError);
    });
  });

  it('guarda: aceita só chave no prefixo do tenant do contexto', () => {
    inTenant(A, () => {
      expect(() => {
        assertTenantStorageKey(`tenants/${A}/uploads/att-1`, 'head');
      }).not.toThrow();
      for (const key of [
        `tenants/${B}/uploads/att-1`,
        `tenants/${A}/`,
        `tenants/${A}/../${B}/x`,
        `tenants/${A}/uploads//x`,
        `outra/${A}/x`,
      ]) {
        expect(() => {
          assertTenantStorageKey(key, 'head');
        }).toThrow(TenantIsolationViolationError);
      }
    });
  });
});

describe('StorageService (storage.md §2 · V-08)', () => {
  it('[Falha de integração] chave de outro tenant: TenantIsolationViolation sem assinar a URL e alerta com correlationId', async () => {
    const storage = fakeStorage();
    const service = new StorageService(storage);
    const attempt = inTenant(A, () =>
      service.presignGet({
        ref: { bucket: 'documents', key: `tenants/${B}/processes/${PROCESS}/attachments/x/a.pdf` },
        downloadFileName: 'a.pdf',
        contentType: 'application/pdf',
      }),
    );
    await expect(attempt).rejects.toBeInstanceOf(TenantIsolationViolationError);
    expect(storage.presignGet).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(
      {
        event: 'security.tenant_isolation_violation',
        barrier: 'storage',
        reason: 'key_outside_tenant_prefix',
        operation: 'presign_get',
        correlationId: 'corr-storage',
      },
      'security.tenant_isolation_violation',
    );
  });

  it('[Sucesso] chave do próprio tenant: delega ao adaptador com expiração de até 300 s', async () => {
    const storage = fakeStorage();
    const service = new StorageService(storage);
    const key = inTenant(A, () => StorageKeyBuilder.quarantine('att-1'));
    await inTenant(A, async () => {
      await service.presignPut({
        ref: { bucket: 'quarantine', key },
        contentType: 'application/pdf',
        contentLength: 10,
      });
      await service.presignGet({
        ref: { bucket: 'quarantine', key },
        downloadFileName: 'a.pdf',
        contentType: 'application/pdf',
        expiresInSeconds: 60,
      });
      await expect(
        service.presignGet({
          ref: { bucket: 'quarantine', key },
          downloadFileName: 'a.pdf',
          contentType: 'application/pdf',
          expiresInSeconds: 301,
        }),
      ).rejects.toBeInstanceOf(PresignExpiryError);
    });
    expect(storage.presignPut).toHaveBeenCalledWith(
      expect.objectContaining({ expiresInSeconds: MAX_PRESIGN_SECONDS }),
    );
    expect(storage.presignGet).toHaveBeenCalledWith(
      expect.objectContaining({ expiresInSeconds: 60 }),
    );
  });

  it('sem o adaptador da US-068, a chamada válida é recusada depois da guarda', async () => {
    const service = new StorageService(new UnconfiguredObjectStorage());
    await inTenant(A, async () => {
      const key = StorageKeyBuilder.quarantine('att-1');
      await expect(
        service.presignPut({
          ref: { bucket: 'quarantine', key },
          contentType: 'application/pdf',
          contentLength: 1,
        }),
      ).rejects.toBeInstanceOf(StorageNotConfiguredError);
      await expect(
        service.presignGet({
          ref: { bucket: 'quarantine', key },
          downloadFileName: 'a.pdf',
          contentType: 'application/pdf',
        }),
      ).rejects.toBeInstanceOf(StorageNotConfiguredError);
    });
  });
});
