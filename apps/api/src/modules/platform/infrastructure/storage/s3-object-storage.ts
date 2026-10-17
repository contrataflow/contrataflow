import { Readable } from 'node:stream';

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { S3Config } from '#config/env.js';
import type {
  BucketClass,
  CopyObjectInput,
  ObjectHead,
  ObjectRef,
  ObjectStorage,
  PresignedRequest,
  PresignGetInput,
  PresignPutInput,
} from '#shared/storage/storage.service.js';

/*
 * Adaptador S3/MinIO do `StorageService` (US-068 · storage.md §2.1): AWS SDK v3 com dois clientes —
 * o interno (`S3_ENDPOINT`, HEAD/GET/Copy/Delete) e o público (`S3_PUBLIC_ENDPOINT`), que só ASSINA
 * as URLs entregues ao navegador. A guarda de tenant fica no serviço; aqui não há regra de negócio.
 * O checksum automático do SDK fica desligado (`WHEN_REQUIRED`): o PUT pré-assinado é feito pelo
 * navegador, que não envia o CRC32 que o SDK assinaria.
 */

function client(config: S3Config, endpoint: string | null): S3Client {
  return new S3Client({
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    ...(endpoint === null ? {} : { endpoint }),
    ...(config.credentials === null ? {} : { credentials: { ...config.credentials } }),
  });
}

/** Objeto inexistente: `NotFound` (HEAD) ou `NoSuchKey` (GET), ou 404 sem corpo. */
function isMissing(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, $metadata } = error as {
    readonly name?: string;
    readonly $metadata?: { readonly httpStatusCode?: number };
  };
  return name === 'NotFound' || name === 'NoSuchKey' || $metadata?.httpStatusCode === 404;
}

/** `Content-Disposition: attachment` com nome ASCII e UTF-8 (RFC 6266/8187 — storage.md §6). */
export function attachmentDisposition(fileName: string): string {
  const ascii = fileName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly internal: S3Client;
  private readonly signer: S3Client;

  constructor(private readonly config: S3Config) {
    this.internal = client(config, config.endpoint);
    this.signer = client(config, config.publicEndpoint ?? config.endpoint);
  }

  private bucket(name: BucketClass): string {
    return this.config.buckets[name];
  }

  async presignPut(
    input: PresignPutInput & { readonly expiresInSeconds: number },
  ): Promise<PresignedRequest> {
    const command = new PutObjectCommand({
      Bucket: this.bucket(input.ref.bucket),
      Key: input.ref.key,
      ContentType: input.contentType,
      ContentLength: input.contentLength,
      ...(input.checksumSha256 ? { ChecksumSHA256: input.checksumSha256 } : {}),
    });
    // Tipo e tamanho assinados: o S3 recusa PUT com outro `Content-Length` (storage.md §5.3).
    const url = await getSignedUrl(this.signer, command, {
      expiresIn: input.expiresInSeconds,
      signableHeaders: new Set(['content-type', 'content-length']),
    });
    return {
      url,
      method: 'PUT',
      headers: { 'Content-Type': input.contentType },
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    };
  }

  async presignGet(
    input: PresignGetInput & { readonly expiresInSeconds: number },
  ): Promise<PresignedRequest> {
    const command = new GetObjectCommand({
      Bucket: this.bucket(input.ref.bucket),
      Key: input.ref.key,
      ...(input.ref.versionId ? { VersionId: input.ref.versionId } : {}),
      ResponseContentDisposition: attachmentDisposition(input.downloadFileName),
      ResponseContentType: input.contentType,
      ResponseCacheControl: 'private, no-store',
    });
    const url = await getSignedUrl(this.signer, command, { expiresIn: input.expiresInSeconds });
    return {
      url,
      method: 'GET',
      headers: {},
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    };
  }

  async head(ref: ObjectRef): Promise<ObjectHead | null> {
    try {
      const result = await this.internal.send(
        new HeadObjectCommand({ Bucket: this.bucket(ref.bucket), Key: ref.key }),
      );
      return { sizeBytes: result.ContentLength ?? 0 };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async openRead(ref: ObjectRef): Promise<Readable | null> {
    try {
      const result = await this.internal.send(
        new GetObjectCommand({ Bucket: this.bucket(ref.bucket), Key: ref.key }),
      );
      const body = result.Body;
      if (body instanceof Readable) return body;
      if (body === undefined) return Readable.from([]);
      return Readable.from(Buffer.from(await body.transformToByteArray()));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async copy(input: CopyObjectInput): Promise<void> {
    const source = `${this.bucket(input.from.bucket)}/${input.from.key
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
    await this.internal.send(
      new CopyObjectCommand({
        Bucket: this.bucket(input.to.bucket),
        Key: input.to.key,
        CopySource: source,
        MetadataDirective: 'REPLACE',
        ContentType: input.contentType,
        Metadata: { ...input.metadata },
        ChecksumAlgorithm: 'SHA256',
      }),
    );
  }

  async delete(ref: ObjectRef): Promise<void> {
    await this.internal.send(
      new DeleteObjectCommand({ Bucket: this.bucket(ref.bucket), Key: ref.key }),
    );
  }
}
