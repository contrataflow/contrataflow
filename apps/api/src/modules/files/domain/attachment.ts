import type {
  AttachmentReasonCode,
  AttachmentStatus,
  AttachmentTargetType,
} from '@contrataflow/types';

/*
 * Agregado `Attachment` (US-068 · entities.md §4 · storage.md §5.1): máquina de estados do fluxo
 * intenção → upload direto → confirmação → varredura → disponível. Puro: sem NestJS, Prisma ou
 * storage. A transição a `AVAILABLE` só existe a partir de `SCANNING` (P3 — RN-DOC-75), e o banco
 * repete a regra no gatilho `attachments_guard`.
 */

/** Registro estruturado do antivírus e da checagem de tipo (nunca exposto na API). */
export interface ScanResult {
  /** Tentativa do `file-scan` que detém a varredura (trava condicional — RN-DOC-74). */
  readonly claim?: { readonly attempt: number; readonly at: string };
  readonly engine?: string;
  readonly engineVersion?: string | null;
  /** Assinatura detectada (só no banco — nunca em log, evento ou resposta). */
  readonly signature?: string | null;
  readonly reasonCode?: AttachmentReasonCode;
  readonly detectedMimeType?: string | null;
  readonly durationMs?: number;
}

export interface Attachment {
  readonly id: string;
  readonly tenantId: string;
  readonly processId: string | null;
  readonly targetType: AttachmentTargetType;
  readonly targetId: string | null;
  readonly categoryId: string | null;
  readonly fileName: string;
  readonly extension: string;
  readonly declaredMimeType: string;
  readonly detectedMimeType: string | null;
  readonly sizeBytes: number;
  readonly sha256: string | null;
  readonly storageKey: string;
  readonly quarantineKey: string | null;
  readonly status: AttachmentStatus;
  readonly scanResult: ScanResult | null;
  readonly scannedAt: Date | null;
  readonly description: string | null;
  readonly uploadedById: string;
  readonly uploadedAt: Date | null;
  readonly deletionReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly updatedById: string | null;
  readonly deletedAt: Date | null;
  readonly deletedById: string | null;
  readonly version: number;
}

/** Transição fora de storage.md §5.1: erro de programação ou corrida já tratada pelo chamador. */
export class AttachmentTransitionError extends Error {
  constructor(
    readonly from: AttachmentStatus,
    readonly to: AttachmentStatus,
  ) {
    super(`Transição de anexo inválida: ${from} → ${to}.`);
    this.name = 'AttachmentTransitionError';
  }
}

const TRANSITIONS: Readonly<Record<AttachmentStatus, readonly AttachmentStatus[]>> = {
  PENDING_UPLOAD: ['UPLOADED', 'REJECTED', 'DELETED'],
  UPLOADED: ['SCANNING'],
  SCANNING: ['SCANNING', 'AVAILABLE', 'INFECTED', 'REJECTED'],
  AVAILABLE: ['DELETED'],
  INFECTED: [],
  REJECTED: [],
  DELETED: [],
};

export function canTransition(from: AttachmentStatus, to: AttachmentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

function transition(
  attachment: Attachment,
  to: AttachmentStatus,
  changes: Partial<Attachment>,
  now: Date,
  userId: string | null,
): Attachment {
  if (!canTransition(attachment.status, to)) {
    throw new AttachmentTransitionError(attachment.status, to);
  }
  return {
    ...attachment,
    ...changes,
    status: to,
    updatedAt: now,
    updatedById: userId,
    version: attachment.version + 1,
  };
}

export interface NewAttachmentInput {
  readonly id: string;
  readonly tenantId: string;
  readonly processId: string | null;
  readonly targetType: AttachmentTargetType;
  readonly targetId: string;
  readonly categoryId: string | null;
  readonly fileName: string;
  readonly extension: string;
  readonly declaredMimeType: string;
  readonly sizeBytes: number;
  readonly storageKey: string;
  readonly quarantineKey: string;
  readonly description: string | null;
  readonly uploadedById: string;
  readonly now: Date;
}

/** RN-DOC-71: a intenção nasce `PENDING_UPLOAD`, com as chaves calculadas no servidor. */
export function createAttachment(input: NewAttachmentInput): Attachment {
  return {
    id: input.id,
    tenantId: input.tenantId,
    processId: input.processId,
    targetType: input.targetType,
    targetId: input.targetId,
    categoryId: input.categoryId,
    fileName: input.fileName,
    extension: input.extension,
    declaredMimeType: input.declaredMimeType,
    detectedMimeType: null,
    sizeBytes: input.sizeBytes,
    sha256: null,
    storageKey: input.storageKey,
    quarantineKey: input.quarantineKey,
    status: 'PENDING_UPLOAD',
    scanResult: null,
    scannedAt: null,
    description: input.description,
    uploadedById: input.uploadedById,
    uploadedAt: null,
    deletionReason: null,
    createdAt: input.now,
    updatedAt: input.now,
    updatedById: input.uploadedById,
    deletedAt: null,
    deletedById: null,
    version: 1,
  };
}

/**
 * RN-DOC-73: objeto na quarentena com o tamanho declarado → `UPLOADED`; tamanho divergente →
 * `REJECTED` (`SIZE_MISMATCH`), sem varredura.
 */
export function confirmUpload(
  attachment: Attachment,
  objectSizeBytes: number,
  now: Date,
  userId: string,
): Attachment {
  if (objectSizeBytes !== attachment.sizeBytes) {
    return transition(
      attachment,
      'REJECTED',
      { uploadedAt: now, scanResult: { reasonCode: 'SIZE_MISMATCH' } },
      now,
      userId,
    );
  }
  return transition(attachment, 'UPLOADED', { uploadedAt: now }, now, userId);
}

/** RN-DOC-74: a tentativa `attempt` do `file-scan` assume a varredura. */
export function startScanning(attachment: Attachment, attempt: number, now: Date): Attachment {
  return transition(
    attachment,
    'SCANNING',
    { scanResult: { claim: { attempt, at: now.toISOString() } } },
    now,
    null,
  );
}

/**
 * Devolve a trava sem resultado (antivírus fora do ar — FA-05): o anexo segue `SCANNING`, e a MESMA
 * tentativa, quando o job voltar sem consumir tentativa, pode assumir de novo.
 */
export function releaseScan(attachment: Attachment, attempt: number, now: Date): Attachment {
  return transition(
    attachment,
    'SCANNING',
    { scanResult: { claim: { attempt: attempt - 1, at: now.toISOString() } } },
    now,
    null,
  );
}

/** Tentativa que detém a varredura (0 = nenhuma). */
export function claimedAttempt(attachment: Attachment): number {
  return attachment.scanResult?.claim?.attempt ?? 0;
}

/**
 * A tentativa pode assumir a varredura: `UPLOADED`, ou `SCANNING` de tentativa anterior (retry) ou
 * com a trava vencida (worker caiu no meio). Duas entregas da MESMA tentativa → só a primeira.
 */
export function canClaimScan(
  attachment: Attachment,
  attempt: number,
  now: Date,
  leaseMs: number,
): boolean {
  if (attachment.status === 'UPLOADED') return true;
  if (attachment.status !== 'SCANNING') return false;
  if (claimedAttempt(attachment) < attempt) return true;
  return now.getTime() - attachment.updatedAt.getTime() >= leaseMs;
}

export interface CleanScan {
  readonly sha256: string;
  readonly detectedMimeType: string;
  readonly scanResult: ScanResult;
}

/** RN-DOC-76 · P3: somente a varredura limpa promove a `AVAILABLE`. */
export function markAvailable(attachment: Attachment, scan: CleanScan, now: Date): Attachment {
  return transition(
    attachment,
    'AVAILABLE',
    {
      sha256: scan.sha256,
      detectedMimeType: scan.detectedMimeType,
      scanResult: scan.scanResult,
      scannedAt: now,
    },
    now,
    null,
  );
}

/** RN-DOC-76: malware → `INFECTED`; tipo, estrutura ou tamanho inválido → `REJECTED`. */
export function markRejected(
  attachment: Attachment,
  status: 'INFECTED' | 'REJECTED',
  scan: { readonly sha256: string | null; readonly scanResult: ScanResult },
  now: Date,
): Attachment {
  return transition(
    attachment,
    status,
    {
      sha256: scan.sha256,
      detectedMimeType: scan.scanResult.detectedMimeType ?? null,
      scanResult: scan.scanResult,
      scannedAt: now,
    },
    now,
    null,
  );
}

/** RN-DOC-79 (DEC-034): exclusão lógica com motivo; o binário fica retido (PEND-07). */
export function deleteAttachment(
  attachment: Attachment,
  reason: string,
  now: Date,
  userId: string | null,
): Attachment {
  return transition(
    attachment,
    'DELETED',
    { deletionReason: reason, deletedAt: now, deletedById: userId },
    now,
    userId,
  );
}

/** Motivo resumido de `INFECTED`/`REJECTED` exposto ao cliente (sem a assinatura). */
export function reasonCodeOf(attachment: Attachment): AttachmentReasonCode | null {
  if (attachment.status === 'INFECTED') return 'INFECTED';
  if (attachment.status !== 'REJECTED') return null;
  return attachment.scanResult?.reasonCode ?? 'STRUCTURAL_CHECK_FAILED';
}
