import { describe, expect, it } from 'vitest';

import { S3ObjectStorage, attachmentDisposition } from './s3-object-storage.js';

/*
 * Adaptador S3 (US-068 · storage.md §2.1/§6): a assinatura é local (SigV4, sem rede) — aqui se
 * confere o que vai na URL. O round-trip real com o MinIO fica na integração.
 */

const storage = new S3ObjectStorage({
  endpoint: 'http://minio:9000',
  publicEndpoint: 'http://localhost:9000',
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: 'contrataflow-app', secretAccessKey: 'devpassword' },
  buckets: {
    quarantine: 'contrataflow-test-quarantine',
    documents: 'contrataflow-test-documents',
    renditions: 'contrataflow-test-renditions',
  },
});

describe('S3ObjectStorage', () => {
  it('PUT pré-assinado no host público, com tipo e tamanho assinados e validade pedida', async () => {
    const key = 'tenants/0192a000-0000-7000-8000-00000000000a/uploads/att-1';
    const signed = await storage.presignPut({
      ref: { bucket: 'quarantine', key },
      contentType: 'application/pdf',
      contentLength: 2048,
      expiresInSeconds: 300,
    });
    const url = new URL(signed.url);
    expect(url.origin).toBe('http://localhost:9000');
    expect(url.pathname).toBe(`/contrataflow-test-quarantine/${key}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(url.searchParams.has('x-amz-checksum-crc32')).toBe(false);
    expect(signed).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'application/pdf' } });
    expect(signed.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(300_000);
  });

  it('GET pré-assinado sempre como anexo, sem cache e com o tipo detectado', async () => {
    const signed = await storage.presignGet({
      ref: { bucket: 'documents', key: 'tenants/x/assets/a/logo.png' },
      downloadFileName: 'Brasão São José.png',
      contentType: 'image/png',
      expiresInSeconds: 60,
    });
    const url = new URL(signed.url);
    expect(url.searchParams.get('response-content-type')).toBe('image/png');
    expect(url.searchParams.get('response-cache-control')).toBe('private, no-store');
    expect(url.searchParams.get('response-content-disposition')).toBe(
      attachmentDisposition('Brasão São José.png'),
    );
  });

  it('Content-Disposition com nome ASCII e UTF-8 (RFC 6266/8187)', () => {
    expect(attachmentDisposition('Orçamento "final".pdf')).toBe(
      `attachment; filename="Orcamento _final_.pdf"; filename*=UTF-8''Or%C3%A7amento%20%22final%22.pdf`,
    );
  });
});
