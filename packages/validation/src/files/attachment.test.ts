import { UPLOAD_FILE_TYPES, isUploadExtension } from '@contrataflow/types';
import { describe, expect, it } from 'vitest';

import {
  attachmentDownloadSchema,
  createAttachmentIntentSchema,
  deleteAttachmentSchema,
  hasInlinePreview,
} from './attachment.js';
import { AttachmentRejected, AttachmentUploaded } from './events.js';
import { PLATFORM_UPLOAD_EXTENSIONS } from '../tenancy/settings.js';

const TARGET = '0192c000-0000-7000-8000-00000000d001';

describe('allowlist de upload (storage.md §7)', () => {
  it('o registro técnico cobre exatamente a allowlist da plataforma', () => {
    expect(Object.keys(UPLOAD_FILE_TYPES).sort()).toEqual([...PLATFORM_UPLOAD_EXTENSIONS].sort());
    expect(isUploadExtension('pdf')).toBe(true);
    expect(isUploadExtension('exe')).toBe(false);
    expect(isUploadExtension('constructor')).toBe(false);
  });

  it('todo MIME canônico é aceito como declarado', () => {
    for (const type of Object.values(UPLOAD_FILE_TYPES)) {
      expect(type.declaredMimeTypes as readonly string[]).toContain(type.mimeType);
    }
  });
});

describe('createAttachmentIntentSchema (ATT-02)', () => {
  const valid = {
    targetType: 'DOCUMENT',
    targetId: TARGET,
    fileName: '  comprovante.pdf ',
    declaredMimeType: 'Application/PDF',
    sizeBytes: 2 * 1024 * 1024,
  };

  it('normaliza nome e MIME', () => {
    expect(createAttachmentIntentSchema.parse(valid)).toMatchObject({
      fileName: 'comprovante.pdf',
      declaredMimeType: 'application/pdf',
    });
  });

  it('recusa arquivo vazio (V-03) e chave de storage vinda do cliente (RN-DOC-77)', () => {
    expect(createAttachmentIntentSchema.safeParse({ ...valid, sizeBytes: 0 }).success).toBe(false);
    expect(
      createAttachmentIntentSchema.safeParse({ ...valid, storageKey: 'tenants/x/uploads/y' })
        .success,
    ).toBe(false);
    expect(
      createAttachmentIntentSchema.safeParse({ ...valid, targetType: 'SOMETHING' }).success,
    ).toBe(false);
  });

  it('não decide allowlist nem limite (415/413 são da API)', () => {
    expect(
      createAttachmentIntentSchema.safeParse({
        ...valid,
        fileName: 'script.exe',
        sizeBytes: 10 ** 12,
      }).success,
    ).toBe(true);
  });
});

describe('deleteAttachmentSchema (ATT-06)', () => {
  it('exige o motivo (V-07)', () => {
    expect(deleteAttachmentSchema.safeParse({ deletionReason: '   ' }).success).toBe(false);
    expect(deleteAttachmentSchema.safeParse({}).success).toBe(false);
    expect(deleteAttachmentSchema.parse({ deletionReason: ' duplicado ' })).toEqual({
      deletionReason: 'duplicado',
    });
  });
});

describe('eventos de anexo', () => {
  it('AttachmentUploaded exige sha256 em hexadecimal', () => {
    const payload = {
      attachmentId: TARGET,
      targetType: 'DOCUMENT',
      targetId: TARGET,
      fileName: 'comprovante.pdf',
      sizeBytes: 10,
      sha256: 'a'.repeat(64),
    };
    expect(AttachmentUploaded.payloadSchema.safeParse(payload).success).toBe(true);
    expect(AttachmentUploaded.payloadSchema.safeParse({ ...payload, sha256: 'xyz' }).success).toBe(
      false,
    );
  });

  it('AttachmentRejected só com INFECTED/REJECTED', () => {
    expect(
      AttachmentRejected.payloadSchema.safeParse({
        attachmentId: TARGET,
        status: 'AVAILABLE',
        reasonCode: 'INFECTED',
      }).success,
    ).toBe(false);
  });
});

describe('ATT-05 e a prévia inline (US-064 · RN-DOC-36)', () => {
  it('prévia nativa só para PDF, PNG e JPEG (sem diferenciar maiúsculas)', () => {
    for (const extension of ['pdf', 'png', 'jpg', 'JPEG'])
      expect(hasInlinePreview(extension)).toBe(true);
    for (const extension of ['docx', 'xlsx', 'odt', 'csv', 'zip']) {
      expect(hasInlinePreview(extension)).toBe(false);
    }
  });

  it('ATT-05 responde URL e validade ISO', () => {
    expect(
      attachmentDownloadSchema.safeParse({
        url: 'https://s3.test/x',
        expiresAt: '2026-10-17T12:05:00.000Z',
      }).success,
    ).toBe(true);
    expect(attachmentDownloadSchema.safeParse({ url: 'x', expiresAt: 'ontem' }).success).toBe(
      false,
    );
  });
});
