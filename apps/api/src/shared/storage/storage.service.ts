import { Inject, Injectable } from '@nestjs/common';

import { assertTenantStorageKey } from './storage-keys.js';

/*
 * Porta de storage com a guarda de tenant (US-100 · RN-TEN-30 · storage.md §2). O adaptador S3/MinIO
 * (`ObjectStorage`) chega com a US-068; aqui fica o que é de isolamento: toda operação confere o
 * prefixo `tenants/{tenantId}/` do contexto antes de chegar ao adaptador e limita as URLs
 * pré-assinadas a 300 s (DEC-136).
 */

export type BucketClass = 'quarantine' | 'documents' | 'renditions';

export interface ObjectRef {
  readonly bucket: BucketClass;
  /** Sempre `tenants/{tenantId}/…`, montada pelo `StorageKeyBuilder`. */
  readonly key: string;
  readonly versionId?: string;
}

export interface PresignedRequest {
  /** Credencial ao portador: nunca logar nem persistir. */
  readonly url: string;
  readonly method: 'PUT' | 'GET';
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

export interface PresignGetInput {
  readonly ref: ObjectRef;
  readonly downloadFileName: string;
  readonly contentType: string;
  readonly expiresInSeconds?: number;
}

export interface PresignPutInput {
  readonly ref: ObjectRef;
  readonly contentType: string;
  readonly contentLength: number;
  readonly checksumSha256?: string;
  readonly expiresInSeconds?: number;
}

/** Adaptador do provedor (S3/MinIO — US-068): não sabe de tenant; a guarda fica no serviço. */
export interface ObjectStorage {
  presignGet(
    input: PresignGetInput & { readonly expiresInSeconds: number },
  ): Promise<PresignedRequest>;
  presignPut(
    input: PresignPutInput & { readonly expiresInSeconds: number },
  ): Promise<PresignedRequest>;
}

export const OBJECT_STORAGE = Symbol('ObjectStorage');

/** Expiração máxima das URLs pré-assinadas (DEC-136). */
export const MAX_PRESIGN_SECONDS = 300;

/** Expiração acima do teto ou não positiva: erro de programação. */
export class PresignExpiryError extends Error {
  constructor() {
    super(`URL pré-assinada aceita de 1 a ${MAX_PRESIGN_SECONDS} s.`);
    this.name = 'PresignExpiryError';
  }
}

/** Storage ainda não configurado neste processo (o adaptador real é da US-068). */
export class StorageNotConfiguredError extends Error {
  constructor() {
    super('Armazenamento de objetos não configurado.');
    this.name = 'StorageNotConfiguredError';
  }
}

/** Adaptador padrão até a US-068: recusa tudo (depois da guarda de tenant). */
export class UnconfiguredObjectStorage implements ObjectStorage {
  presignGet(): Promise<PresignedRequest> {
    return Promise.reject(new StorageNotConfiguredError());
  }

  presignPut(): Promise<PresignedRequest> {
    return Promise.reject(new StorageNotConfiguredError());
  }
}

function expiry(expiresInSeconds: number | undefined): number {
  const seconds = expiresInSeconds ?? MAX_PRESIGN_SECONDS;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_PRESIGN_SECONDS) {
    throw new PresignExpiryError();
  }
  return seconds;
}

/**
 * `StorageService` (storage.md §2): única entrada dos módulos para o bucket. Chave fora do tenant do
 * contexto → `TenantIsolationViolationError` sem assinar nada (Gherkin "Chave de storage de outro
 * tenant é recusada").
 */
@Injectable()
export class StorageService {
  constructor(@Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage) {}

  async presignGet(input: PresignGetInput): Promise<PresignedRequest> {
    assertTenantStorageKey(input.ref.key, 'presign_get');
    const expiresInSeconds = expiry(input.expiresInSeconds);
    return await this.storage.presignGet({ ...input, expiresInSeconds });
  }

  async presignPut(input: PresignPutInput): Promise<PresignedRequest> {
    assertTenantStorageKey(input.ref.key, 'presign_put');
    const expiresInSeconds = expiry(input.expiresInSeconds);
    return await this.storage.presignPut({ ...input, expiresInSeconds });
  }
}
