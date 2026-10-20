import type { AttachmentStatus, AttachmentTargetType } from '@contrataflow/types';

/*
 * Arquivo de uma versão de documento externo (US-064 · RN-DOC-33/34 · DEC-017/084 · DEC-136): a
 * `DocumentVersion` de `reason = UPLOAD` nasce de um anexo `AVAILABLE` DO PRÓPRIO documento
 * (`targetType = DOCUMENT`, `targetId = documentId`) — `content` nulo, `attachmentId` do anexo e
 * `contentHash` = SHA-256 calculado pelo `file-scan`. Puro: o chamador traduz a recusa em HTTP.
 */

/** O que a regra lê do anexo (a porta `AttachmentFileRegistry` do shared kernel o entrega). */
export interface UploadCandidate {
  readonly id: string;
  readonly targetType: AttachmentTargetType;
  readonly targetId: string | null;
  readonly status: AttachmentStatus;
  readonly sha256: string | null;
}

export type UploadedFileRefusal =
  /** Inexistente, de outro tenant, excluído ou de outro alvo (422 `REFERENCE_NOT_FOUND`). */
  | 'NOT_FOUND'
  /** Ainda em varredura, infectado ou rejeitado (409 `ATTACHMENT_NOT_AVAILABLE`). */
  | 'NOT_AVAILABLE';

export interface UploadedVersionFile {
  readonly attachmentId: string;
  readonly contentHash: string;
}

export type UploadedFileDecision =
  | { readonly ok: true; readonly file: UploadedVersionFile }
  | { readonly ok: false; readonly refusal: UploadedFileRefusal };

const SHA256 = /^[0-9a-f]{64}$/;

export function uploadedVersionFile(
  attachment: UploadCandidate | null,
  documentId: string,
): UploadedFileDecision {
  if (attachment?.targetType !== 'DOCUMENT' || attachment.targetId !== documentId) {
    return { ok: false, refusal: 'NOT_FOUND' };
  }
  // P3 (RN-DOC-75): só o que passou pela varredura — e tem o hash dela — vira versão.
  if (attachment.status !== 'AVAILABLE' || attachment.sha256 === null) {
    return { ok: false, refusal: 'NOT_AVAILABLE' };
  }
  const contentHash = attachment.sha256.toLowerCase();
  if (!SHA256.test(contentHash)) return { ok: false, refusal: 'NOT_AVAILABLE' };
  return { ok: true, file: { attachmentId: attachment.id, contentHash } };
}
