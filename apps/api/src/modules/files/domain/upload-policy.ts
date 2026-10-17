import { UPLOAD_FILE_TYPES, isUploadExtension } from '@contrataflow/types';
import type { UploadExtension } from '@contrataflow/types';

/*
 * Allowlist e limite da intenção (US-068 · RN-DOC-72 · storage.md §7/§8): a extensão precisa estar
 * na allowlist da plataforma E na do tenant (`uploads.allowedExtensions`) e ser coerente com o MIME
 * declarado; o tamanho fica entre 1 byte e `uploads.maxFileSizeMb` (teto de 100 MB da plataforma).
 * Pura: a decisão de código HTTP (415/413) é da aplicação.
 */

export interface UploadLimits {
  readonly allowedExtensions: readonly string[];
  readonly maxFileSizeMb: number;
}

export interface UploadCandidate {
  readonly fileName: string;
  readonly declaredMimeType: string;
  readonly sizeBytes: number;
}

export type UploadCheck =
  | { readonly ok: true; readonly extension: UploadExtension }
  | { readonly ok: false; readonly violation: 'TYPE_NOT_ALLOWED' | 'TOO_LARGE' };

const MB = 1024 * 1024;

/** Extensão em minúsculas do último `.` (sem extensão → `''`). */
export function extensionOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot <= 0 || dot === base.length - 1 ? '' : base.slice(dot + 1).toLowerCase();
}

/** Extensões efetivas do tenant: só as da plataforma (o tenant restringe, nunca amplia). */
export function effectiveExtensions(limits: UploadLimits): UploadExtension[] {
  return limits.allowedExtensions.filter(isUploadExtension);
}

export function checkUpload(candidate: UploadCandidate, limits: UploadLimits): UploadCheck {
  const extension = extensionOf(candidate.fileName);
  if (!isUploadExtension(extension) || !effectiveExtensions(limits).includes(extension)) {
    return { ok: false, violation: 'TYPE_NOT_ALLOWED' };
  }
  const declared = UPLOAD_FILE_TYPES[extension].declaredMimeTypes as readonly string[];
  if (!declared.includes(candidate.declaredMimeType.toLowerCase())) {
    return { ok: false, violation: 'TYPE_NOT_ALLOWED' };
  }
  if (candidate.sizeBytes > limits.maxFileSizeMb * MB) {
    return { ok: false, violation: 'TOO_LARGE' };
  }
  return { ok: true, extension };
}
