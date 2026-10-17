import type { Readable } from 'node:stream';

import { Inject, Injectable } from '@nestjs/common';

import { assertTenantStorageKey } from './storage-keys.js';

/*
 * Porta de storage com a guarda de tenant (US-100 · RN-TEN-30 · storage.md §2). O adaptador S3/MinIO
 * (`ObjectStorage`) é da US-068 (`modules/platform`); aqui fica o que é de isolamento: toda
 * operação confere o prefixo `tenants/{tenantId}/` do contexto antes de chegar ao adaptador e
 * limita as URLs pré-assinadas a 300 s (DEC-136).
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

/** Resultado do `HEAD` (confirmação do upload — RN-DOC-73). */
export interface ObjectHead {
  readonly sizeBytes: number;
}

/** Metadados `x-amz-meta-*` (storage.md §4): nunca nome de arquivo nem dado pessoal. */
export type ObjectMetadata = Readonly<Record<string, string>>;

export interface CopyObjectInput {
  readonly from: ObjectRef;
  readonly to: ObjectRef;
  readonly contentType: string;
  readonly metadata: ObjectMetadata;
}

/** Adaptador do provedor (S3/MinIO — US-068): não sabe de tenant; a guarda fica no serviço. */
export interface ObjectStorage {
  presignGet(
    input: PresignGetInput & { readonly expiresInSeconds: number },
  ): Promise<PresignedRequest>;
  presignPut(
    input: PresignPutInput & { readonly expiresInSeconds: number },
  ): Promise<PresignedRequest>;
  /** `null` = objeto inexistente. */
  head(ref: ObjectRef): Promise<ObjectHead | null>;
  /** Leitura em stream único (varredura — storage.md §5.3); `null` = objeto inexistente. */
  openRead(ref: ObjectRef): Promise<Readable | null>;
  /** Cópia no servidor (promoção quarentena → `documents`), com checksum SHA-256. */
  copy(input: CopyObjectInput): Promise<void>;
  /** Idempotente: objeto ausente não é erro. */
  delete(ref: ObjectRef): Promise<void>;
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

/** Storage não configurado neste processo (sem `S3_*` no ambiente). */
export class StorageNotConfiguredError extends Error {
  constructor() {
    super('Armazenamento de objetos não configurado.');
    this.name = 'StorageNotConfiguredError';
  }
}

/** Adaptador sem `S3_*` configurado: recusa tudo (depois da guarda de tenant). */
export class UnconfiguredObjectStorage implements ObjectStorage {
  presignGet(): Promise<PresignedRequest> {
    return Promise.reject(new StorageNotConfiguredError());
  }

  presignPut(): Promise<PresignedRequest> {
    return Promise.reject(new StorageNotConfiguredError());
  }

  head(): Promise<ObjectHead | null> {
    return Promise.reject(new StorageNotConfiguredError());
  }

  openRead(): Promise<Readable | null> {
    return Promise.reject(new StorageNotConfiguredError());
  }

  copy(): Promise<void> {
    return Promise.reject(new StorageNotConfiguredError());
  }

  delete(): Promise<void> {
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

  async head(ref: ObjectRef): Promise<ObjectHead | null> {
    assertTenantStorageKey(ref.key, 'head');
    return await this.storage.head(ref);
  }

  async openRead(ref: ObjectRef): Promise<Readable | null> {
    assertTenantStorageKey(ref.key, 'read');
    return await this.storage.openRead(ref);
  }

  /** As duas chaves no prefixo do tenant do contexto: promoção nunca cruza tenants. */
  async copy(input: CopyObjectInput): Promise<void> {
    assertTenantStorageKey(input.from.key, 'copy');
    assertTenantStorageKey(input.to.key, 'copy');
    await this.storage.copy(input);
  }

  async delete(ref: ObjectRef): Promise<void> {
    assertTenantStorageKey(ref.key, 'delete');
    await this.storage.delete(ref);
  }
}
