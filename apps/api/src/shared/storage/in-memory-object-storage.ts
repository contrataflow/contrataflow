import { Readable } from 'node:stream';

import type {
  BucketClass,
  CopyObjectInput,
  ObjectHead,
  ObjectRef,
  ObjectStorage,
  PresignedRequest,
  PresignGetInput,
  PresignPutInput,
  PutObjectInput,
} from './storage.service.js';

/*
 * `ObjectStorage` em memória (testes da US-068): os "buckets" são mapas; `put` simula o PUT direto
 * do navegador na quarentena. `failing` simula o provedor fora do ar (503).
 */

export interface StoredObject {
  readonly body: Buffer;
  readonly contentType: string | null;
  readonly metadata: Readonly<Record<string, string>>;
  readonly tags?: Readonly<Record<string, string>>;
}

export class InMemoryObjectStorage implements ObjectStorage {
  readonly buckets: Record<BucketClass, Map<string, StoredObject>> = {
    quarantine: new Map(),
    documents: new Map(),
    renditions: new Map(),
  };

  failing: Error | null = null;

  /** O navegador enviando os bytes pela URL pré-assinada. */
  put(ref: ObjectRef, body: Buffer | string, contentType: string | null = null): void {
    this.buckets[ref.bucket].set(ref.key, {
      body: Buffer.from(body),
      contentType,
      metadata: {},
    });
  }

  get(ref: ObjectRef): StoredObject | undefined {
    return this.buckets[ref.bucket].get(ref.key);
  }

  private check(): void {
    if (this.failing) throw this.failing;
  }

  presignPut(
    input: PresignPutInput & { readonly expiresInSeconds: number },
  ): Promise<PresignedRequest> {
    this.check();
    return Promise.resolve({
      url: `https://storage.test/${input.ref.bucket}/${input.ref.key}?X-Amz-Signature=test`,
      method: 'PUT',
      headers: { 'Content-Type': input.contentType },
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    });
  }

  presignGet(
    input: PresignGetInput & { readonly expiresInSeconds: number },
  ): Promise<PresignedRequest> {
    this.check();
    return Promise.resolve({
      url: `https://storage.test/${input.ref.bucket}/${input.ref.key}?X-Amz-Signature=test`,
      method: 'GET',
      headers: {},
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    });
  }

  head(ref: ObjectRef): Promise<ObjectHead | null> {
    this.check();
    const object = this.get(ref);
    return Promise.resolve(object ? { sizeBytes: object.body.length } : null);
  }

  openRead(ref: ObjectRef): Promise<Readable | null> {
    this.check();
    const object = this.get(ref);
    return Promise.resolve(object ? Readable.from([object.body]) : null);
  }

  copy(input: CopyObjectInput): Promise<void> {
    this.check();
    const object = this.get(input.from);
    if (!object) return Promise.reject(new Error('NoSuchKey'));
    this.buckets[input.to.bucket].set(input.to.key, {
      body: object.body,
      contentType: input.contentType,
      metadata: input.metadata,
    });
    return Promise.resolve();
  }

  putObject(input: PutObjectInput): Promise<void> {
    this.check();
    this.buckets[input.ref.bucket].set(input.ref.key, {
      body: Buffer.from(input.body),
      contentType: input.contentType,
      metadata: input.metadata,
      tags: input.tags,
    });
    return Promise.resolve();
  }

  delete(ref: ObjectRef): Promise<void> {
    this.check();
    this.buckets[ref.bucket].delete(ref.key);
    return Promise.resolve();
  }
}
