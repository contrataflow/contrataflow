import { describe, expect, it } from 'vitest';

import { uploadedVersionFile } from './uploaded-version.js';
import type { UploadCandidate } from './uploaded-version.js';

const DOCUMENT = '0192f064-0000-7000-8000-0000000000d1';
const HASH = 'ab'.repeat(32);

function file(overrides: Partial<UploadCandidate> = {}): UploadCandidate {
  return {
    id: '0192f064-0000-7000-8000-0000000000e1',
    targetType: 'DOCUMENT',
    targetId: DOCUMENT,
    status: 'AVAILABLE',
    sha256: HASH,
    ...overrides,
  };
}

describe('uploadedVersionFile (RN-DOC-33/34 — DocumentVersion.fromUpload)', () => {
  it('anexo AVAILABLE do próprio documento: attachmentId e contentHash = SHA-256 do arquivo', () => {
    expect(uploadedVersionFile(file(), DOCUMENT)).toEqual({
      ok: true,
      file: { attachmentId: file().id, contentHash: HASH },
    });
    expect(uploadedVersionFile(file({ sha256: HASH.toUpperCase() }), DOCUMENT)).toMatchObject({
      ok: true,
      file: { contentHash: HASH },
    });
  });

  it('inexistente, de outro tenant (RLS → null), de outro documento ou de outro alvo → NOT_FOUND', () => {
    expect(uploadedVersionFile(null, DOCUMENT)).toEqual({ ok: false, refusal: 'NOT_FOUND' });
    expect(
      uploadedVersionFile(file({ targetId: '0192f064-0000-7000-8000-0000000000d2' }), DOCUMENT),
    ).toEqual({ ok: false, refusal: 'NOT_FOUND' });
    expect(uploadedVersionFile(file({ targetType: 'PROCESS' }), DOCUMENT)).toEqual({
      ok: false,
      refusal: 'NOT_FOUND',
    });
    expect(uploadedVersionFile(file({ targetId: null }), DOCUMENT)).toMatchObject({ ok: false });
  });

  it.each(['PENDING_UPLOAD', 'UPLOADED', 'SCANNING', 'INFECTED', 'REJECTED'] as const)(
    'anexo %s nunca vira versão (P3) → NOT_AVAILABLE',
    (status) => {
      expect(uploadedVersionFile(file({ status, sha256: null }), DOCUMENT)).toEqual({
        ok: false,
        refusal: 'NOT_AVAILABLE',
      });
    },
  );

  it('AVAILABLE sem hash válido da varredura → NOT_AVAILABLE (defesa)', () => {
    expect(uploadedVersionFile(file({ sha256: null }), DOCUMENT)).toMatchObject({ ok: false });
    expect(uploadedVersionFile(file({ sha256: 'xyz' }), DOCUMENT)).toEqual({
      ok: false,
      refusal: 'NOT_AVAILABLE',
    });
  });
});
