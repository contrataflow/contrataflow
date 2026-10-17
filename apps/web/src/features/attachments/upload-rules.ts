import { UPLOAD_FILE_TYPES, isUploadExtension } from '@contrataflow/types';
import { PLATFORM_UPLOAD_EXTENSIONS } from '@contrataflow/validation';

/*
 * Validação LOCAL do seletor (US-068 · FA-01 · V-01..V-03): feedback imediato com a allowlist da
 * plataforma e o limite padrão do tenant. A regra que vale é a da API (415/413 com a lista e o
 * limite do tenant — `uploads.*` não é configuração pública); a UI só evita a viagem óbvia.
 */

/** Padrão de `uploads.maxFileSizeMb` (storage.md §8). */
export const DEFAULT_MAX_FILE_SIZE_MB = 50;

export type LocalFileCheck =
  | { readonly ok: true; readonly mimeType: string }
  | { readonly ok: false; readonly reason: 'TYPE' | 'SIZE' | 'EMPTY' };

/** `accept` do `<input type="file">` com as extensões da plataforma. */
export const ACCEPT_ATTRIBUTE = PLATFORM_UPLOAD_EXTENSIONS.map((extension) => `.${extension}`).join(
  ',',
);

export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot <= 0 || dot === fileName.length - 1 ? '' : fileName.slice(dot + 1).toLowerCase();
}

/** O MIME a declarar: o do navegador quando coerente; senão o canônico da extensão. */
export function checkLocalFile(
  file: Pick<File, 'name' | 'size' | 'type'>,
  maxFileSizeMb: number = DEFAULT_MAX_FILE_SIZE_MB,
): LocalFileCheck {
  const extension = extensionOf(file.name);
  if (!isUploadExtension(extension)) return { ok: false, reason: 'TYPE' };
  if (file.size === 0) return { ok: false, reason: 'EMPTY' };
  if (file.size > maxFileSizeMb * 1024 * 1024) return { ok: false, reason: 'SIZE' };
  const type = UPLOAD_FILE_TYPES[extension];
  const declared = file.type.toLowerCase();
  const mimeType = (type.declaredMimeTypes as readonly string[]).includes(declared)
    ? declared
    : type.mimeType;
  return { ok: true, mimeType };
}

/** Tamanho legível em pt-BR (KB/MB). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} KB`;
  }
  return `${(bytes / (1024 * 1024)).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;
}
