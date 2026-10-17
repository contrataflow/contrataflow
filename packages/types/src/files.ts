/*
 * Anexos (US-068 · entities.md §2/§4 `Attachment` · storage.md §5/§7): estados, alvos, motivos de
 * rejeição e o registro técnico da allowlist da plataforma (extensão → MIME canônico → detector),
 * usado pela API na intenção e pelo `file-scan` na varredura. O tenant só RESTRINGE essa lista
 * (`uploads.allowedExtensions`), nunca a amplia.
 */

/** entities.md §2 — `AttachmentTargetType`. */
export const ATTACHMENT_TARGET_TYPES = [
  'PROCESS',
  'DOCUMENT',
  'DOCUMENT_VERSION',
  'PRICE_SOURCE',
  'COMMENT',
  'MOVEMENT',
  'RISK',
  'TENANT_ASSET',
  'TEMPLATE_VERSION',
] as const;
export type AttachmentTargetType = (typeof ATTACHMENT_TARGET_TYPES)[number];

/** Alvos sem processo (`process_id` nulo — check de entities.md §4). */
export const PROCESSLESS_ATTACHMENT_TARGETS: readonly AttachmentTargetType[] = [
  'TENANT_ASSET',
  'TEMPLATE_VERSION',
];

/** entities.md §2 — `AttachmentStatus` (máquina de estados de storage.md §5.1). */
export const ATTACHMENT_STATUSES = [
  'PENDING_UPLOAD',
  'UPLOADED',
  'SCANNING',
  'AVAILABLE',
  'INFECTED',
  'REJECTED',
  'DELETED',
] as const;
export type AttachmentStatus = (typeof ATTACHMENT_STATUSES)[number];

/** Estados "em trânsito" (índice parcial e alerta de anexo preso — queues.md §15.3). */
export const ATTACHMENT_PENDING_STATUSES: readonly AttachmentStatus[] = [
  'PENDING_UPLOAD',
  'UPLOADED',
  'SCANNING',
];

/** Motivos de `INFECTED`/`REJECTED` (US-068 RN-DOC-73/76 · storage.md §5.3). */
export const ATTACHMENT_REASON_CODES = [
  'INFECTED',
  'SIZE_MISMATCH',
  'TYPE_MISMATCH',
  'TYPE_NOT_ALLOWED',
  'STRUCTURAL_CHECK_FAILED',
  'EMPTY_FILE',
  'ENCRYPTED_CONTENT',
  'MACRO_CONTENT',
  'SCAN_LIMITS_EXCEEDED',
] as const;
export type AttachmentReasonCode = (typeof ATTACHMENT_REASON_CODES)[number];

/** Família de detecção por *magic bytes* (storage.md §7, coluna "Assinatura"). */
export type UploadFileFamily = 'pdf' | 'ooxml' | 'odf' | 'png' | 'jpeg' | 'text';

export interface UploadFileType {
  /** MIME canônico — gravado como `detectedMimeType` e usado no download. */
  readonly mimeType: string;
  /** MIMEs que o navegador costuma declarar para a extensão (coerência com o declarado). */
  readonly declaredMimeTypes: readonly string[];
  readonly family: UploadFileFamily;
  /** Entrada do ZIP que identifica o tipo OOXML (`word/`, `xl/`). */
  readonly ooxmlPart?: string;
}

const OCTET_STREAM = 'application/octet-stream';

/** Registro técnico da allowlist da plataforma no MVP 1 (storage.md §7). */
export const UPLOAD_FILE_TYPES = {
  pdf: {
    mimeType: 'application/pdf',
    declaredMimeTypes: ['application/pdf', 'application/x-pdf', OCTET_STREAM],
    family: 'pdf',
  },
  docx: {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    declaredMimeTypes: [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      OCTET_STREAM,
    ],
    family: 'ooxml',
    ooxmlPart: 'word/',
  },
  xlsx: {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    declaredMimeTypes: [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      OCTET_STREAM,
    ],
    family: 'ooxml',
    ooxmlPart: 'xl/',
  },
  odt: {
    mimeType: 'application/vnd.oasis.opendocument.text',
    declaredMimeTypes: ['application/vnd.oasis.opendocument.text', OCTET_STREAM],
    family: 'odf',
  },
  ods: {
    mimeType: 'application/vnd.oasis.opendocument.spreadsheet',
    declaredMimeTypes: ['application/vnd.oasis.opendocument.spreadsheet', OCTET_STREAM],
    family: 'odf',
  },
  csv: {
    mimeType: 'text/csv',
    declaredMimeTypes: ['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel'],
    family: 'text',
  },
  txt: {
    mimeType: 'text/plain',
    declaredMimeTypes: ['text/plain'],
    family: 'text',
  },
  png: { mimeType: 'image/png', declaredMimeTypes: ['image/png'], family: 'png' },
  jpg: {
    mimeType: 'image/jpeg',
    declaredMimeTypes: ['image/jpeg', 'image/pjpeg'],
    family: 'jpeg',
  },
  jpeg: {
    mimeType: 'image/jpeg',
    declaredMimeTypes: ['image/jpeg', 'image/pjpeg'],
    family: 'jpeg',
  },
} as const satisfies Readonly<Record<string, UploadFileType>>;

export type UploadExtension = keyof typeof UPLOAD_FILE_TYPES;

export function isUploadExtension(value: string): value is UploadExtension {
  return Object.hasOwn(UPLOAD_FILE_TYPES, value);
}

/** Validade máxima das URLs pré-assinadas (DEC-136). */
export const ATTACHMENT_PRESIGN_SECONDS = 300;

/** Abandono da intenção: `PENDING_UPLOAD` há mais de 24 h vira `DELETED` (RN-DOC-78). */
export const ATTACHMENT_ABANDON_AFTER_HOURS = 24;

/** Motivo gravado na exclusão de intenções abandonadas (storage.md §5.1, ator `SYSTEM`). */
export const ATTACHMENT_ABANDONED_REASON = 'Upload não concluído';
