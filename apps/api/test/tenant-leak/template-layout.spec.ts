// Logo do layout de impressão sobre PostgreSQL real (US-109 · RN-TPL-23 · Tenant incorreto): o
// logo `TENANT_ASSET` só é aceito do PRÓPRIO tenant — o anexo de B não existe para A (RLS de
// `attachments`), e a resposta é a mesma de um id inexistente (422 `REFERENCE_NOT_FOUND`, sem
// revelar o outro tenant); a renderização também não lê o arquivo de B. Leitor real do `files`
// (`FilesAttachmentFileReader` + `PrismaAttachmentRepository`) pela porta `AttachmentFileRegistry`.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { Readable } from 'node:stream';

import { DEFAULT_TEMPLATE_LAYOUT } from '@contrataflow/validation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TemplateLogoService } from '#modules/document/application/template-logo.js';
import { FilesAttachmentFileReader } from '#modules/files/application/attachment-file.reader.js';
import { createAttachment } from '#modules/files/domain/attachment.js';
import { PrismaAttachmentRepository } from '#modules/files/infrastructure/prisma-attachment.repository.js';
import type { TenantPrismaClient } from '#shared/database/prisma-client.js';
import { ApiError } from '#shared/errors/api-error.js';
import { AttachmentFileRegistry } from '#shared/files/attachment-files.js';
import type { ObjectStorage } from '#shared/storage/storage.service.js';
import { StorageService } from '#shared/storage/storage.service.js';

import { asTenant, startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';

const A = '0192d109-0000-7000-8000-00000000109a';
const B = '0192d109-0000-7000-8000-00000000109b';
const USER_A = '0192d109-0000-7000-8000-0000000109a1';
const USER_B = '0192d109-0000-7000-8000-0000000109b1';
const NOW = new Date('2026-10-17T12:00:00.000Z');
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code) VALUES
  ('${A}', 'prefeitura-a-layout', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC'),
  ('${B}', 'prefeitura-b-layout', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC');
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${USER_A}', 'sub-layout-a', 'a@layout.test', true, 'Felipe'),
  ('${USER_B}', 'sub-layout-b', 'b@layout.test', true, 'Usuário B');
`;

/** Storage que devolve o PNG para qualquer chave (a RLS decide antes). */
const storageStub = {
  openRead: () => Promise.resolve(Readable.from([PNG])),
} as unknown as ObjectStorage;

let sequence = 0;

describe('Feature: logo do layout isolado por tenant sobre PostgreSQL (US-109)', () => {
  let db: TestDatabase;
  let client: TenantPrismaClient;
  const repository = new PrismaAttachmentRepository();
  const files = new AttachmentFileRegistry();
  files.register(new FilesAttachmentFileReader(repository, new StorageService(storageStub)));
  const logos = new TemplateLogoService(files);

  const inTenant = <T>(
    tenantId: string,
    work: Parameters<TenantPrismaClient['$tenantTransaction']>[0],
  ) => asTenant(tenantId, () => client.$tenantTransaction(work)) as Promise<T>;

  /** Logo `AVAILABLE` (a promoção passa pelo gatilho: UPLOADED → SCANNING → AVAILABLE). */
  async function availableLogo(tenantId: string, fileName: string): Promise<string> {
    sequence += 1;
    const id = `0192d109-0000-7000-8000-${String(sequence).padStart(12, '0')}`;
    const attachment = createAttachment({
      id,
      tenantId,
      processId: null,
      targetType: 'TENANT_ASSET',
      targetId: tenantId,
      categoryId: null,
      fileName,
      extension: 'png',
      declaredMimeType: 'image/png',
      sizeBytes: PNG.length,
      storageKey: `tenants/${tenantId}/assets/${id}/${fileName}`,
      quarantineKey: `tenants/${tenantId}/uploads/${id}`,
      description: null,
      uploadedById: tenantId === A ? USER_A : USER_B,
      now: NOW,
    });
    await inTenant(tenantId, (tx) => repository.insert(tx, attachment));
    await db.admin(`UPDATE attachments SET status = 'UPLOADED' WHERE id = $1`, [id]);
    await db.admin(`UPDATE attachments SET status = 'SCANNING' WHERE id = $1`, [id]);
    await db.admin(
      `UPDATE attachments SET status = 'AVAILABLE', sha256 = $2, scanned_at = now(),
              detected_mime_type = 'image/png' WHERE id = $1`,
      [id, 'a'.repeat(64)],
    );
    return id;
  }

  beforeAll(async () => {
    db = await startTestDatabase();
    await db.admin(FIXTURE_SQL);
    client = db.client('cf_app');
  }, 180_000);

  afterAll(async () => {
    await db.stop();
  });

  it('[Tenant incorreto] logo de outro tenant = inexistente (REFERENCE_NOT_FOUND), sem revelar B', async () => {
    const brasao = await availableLogo(A, 'brasao.png');
    const ofB = await availableLogo(B, 'logo-b.png');

    await expect(inTenant(A, (tx) => logos.assertUsable(tx, brasao))).resolves.toBeUndefined();
    const refusal = await inTenant<unknown>(A, (tx) =>
      logos.assertUsable(tx, ofB).then(
        () => null,
        (error: unknown) => error,
      ),
    );
    expect(refusal).toBeInstanceOf(ApiError);
    const error = refusal as ApiError;
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.errors).toEqual([
      {
        field: 'layout.logo.attachmentId',
        code: 'REFERENCE_NOT_FOUND',
        message: 'Selecione um logo válido.',
      },
    ]);
    expect(JSON.stringify(error)).not.toMatch(/LEAK-B|logo-b/);

    // A renderização de A também não lê o arquivo de B (sai sem timbre).
    const layout = {
      ...DEFAULT_TEMPLATE_LAYOUT,
      logo: { attachmentId: ofB, position: 'left' as const, maxHeightMm: 15 },
    };
    await expect(inTenant(A, (tx) => logos.load(tx, layout))).resolves.toBeNull();
    await expect(inTenant(B, (tx) => logos.load(tx, layout))).resolves.toMatchObject({
      dataUri: `data:image/png;base64,${PNG.toString('base64')}`,
    });
  });
});
