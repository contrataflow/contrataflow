import { RENDITION_LIMITS } from '@contrataflow/validation';
import type { RenditionKind, RenditionStatus } from '@contrataflow/validation';

/*
 * `DocumentRendition` (US-067 · RN-DOC-63..69 · ADR-007): o PDF de um documento. Regras puras —
 * fábricas por tipo, a máquina de estados `PENDING → PROCESSING → READY | FAILED` (+ `EXPIRED`
 * da prévia, pelo `maintenance`), a trava condicional do worker e a validade do download. O banco
 * repete as transições num gatilho (`document_renditions_guard`).
 */

export interface DocumentRendition {
  readonly id: string;
  readonly tenantId: string;
  readonly processId: string;
  readonly documentId: string;
  /** Nulo na prévia do rascunho. */
  readonly documentVersionId: string | null;
  /** Revisão do rascunho renderizada (só `PREVIEW`). */
  readonly draftRevision: number | null;
  /** Só `APPROVAL_STAMPED`. */
  readonly approvalId: string | null;
  readonly kind: RenditionKind;
  readonly status: RenditionStatus;
  /** POL-09: o PDF sai com os valores sigilosos ocultos (decidido no pedido). */
  readonly masked: boolean;
  readonly storageKey: string | null;
  readonly sha256: string | null;
  readonly sizeBytes: number | null;
  readonly pageCount: number | null;
  readonly errorCode: string | null;
  /** Sanitizada: nunca conteúdo, valores ou stack. */
  readonly errorMessage: string | null;
  /** Tentativa do job que assumiu a renderização por último (RN-DOC-66). */
  readonly attempts: number;
  readonly requestedById: string | null;
  readonly requestedAt: Date;
  readonly startedAt: Date | null;
  readonly readyAt: Date | null;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

const HOUR_MS = 3_600_000;

/** RN-DOC-68: `PREVIEW.expiresAt = requestedAt + 24 h`. */
export function previewExpiresAt(requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + RENDITION_LIMITS.previewTtlHours * HOUR_MS);
}

interface RequestBase {
  readonly id: string;
  readonly tenantId: string;
  readonly processId: string;
  readonly documentId: string;
  readonly masked: boolean;
  readonly requestedById: string | null;
  readonly now: Date;
}

function pending(
  base: RequestBase,
  shape: Pick<DocumentRendition, 'kind' | 'documentVersionId' | 'draftRevision' | 'approvalId'>,
  expiresAt: Date | null,
): DocumentRendition {
  return {
    id: base.id,
    tenantId: base.tenantId,
    processId: base.processId,
    documentId: base.documentId,
    ...shape,
    status: 'PENDING',
    masked: base.masked,
    storageKey: null,
    sha256: null,
    sizeBytes: null,
    pageCount: null,
    errorCode: null,
    errorMessage: null,
    attempts: 0,
    requestedById: base.requestedById,
    requestedAt: base.now,
    startedAt: null,
    readyAt: null,
    expiresAt,
    createdAt: base.now,
    updatedAt: base.now,
    version: 1,
  };
}

/** DOC-20: prévia do rascunho na revisão atual (marca d'água, 24 h). */
export function requestPreview(
  base: RequestBase & { readonly draftRevision: number },
): DocumentRendition {
  return pending(
    base,
    {
      kind: 'PREVIEW',
      documentVersionId: null,
      draftRevision: base.draftRevision,
      approvalId: null,
    },
    previewExpiresAt(base.now),
  );
}

/** DOC-21: PDF oficial da versão (`CONTENT`) ou selo de uma aprovação (`APPROVAL_STAMPED`). */
export function requestVersionRendition(
  base: RequestBase & {
    readonly documentVersionId: string;
    readonly kind: 'CONTENT' | 'APPROVAL_STAMPED';
    readonly approvalId: string | null;
  },
): DocumentRendition {
  return pending(
    base,
    {
      kind: base.kind,
      documentVersionId: base.documentVersionId,
      draftRevision: null,
      approvalId: base.kind === 'APPROVAL_STAMPED' ? base.approvalId : null,
    },
    null,
  );
}

// --- Máquina de estados --------------------------------------------------------------------------

export class RenditionTransitionError extends Error {
  constructor(from: RenditionStatus, to: RenditionStatus) {
    super(`Transição de rendition inválida: ${from} → ${to}.`);
    this.name = 'RenditionTransitionError';
  }
}

/** Ainda sendo gerado (o front mantém "Gerando PDF…"). */
export function isInProgress(rendition: Pick<DocumentRendition, 'status'>): boolean {
  return rendition.status === 'PENDING' || rendition.status === 'PROCESSING';
}

/**
 * RN-DOC-65 · queues.md §4.4: a trava só sai de `PENDING`, ou de `PROCESSING` deixado por uma
 * tentativa ANTERIOR do job (falha transitória) ou com a trava vencida (worker morto). Duas
 * entregas da mesma tentativa → só uma assume.
 */
export function canClaim(
  rendition: DocumentRendition,
  attempt: number,
  now: Date,
  leaseMs: number,
): boolean {
  if (rendition.status === 'PENDING') return true;
  if (rendition.status !== 'PROCESSING') return false;
  if (rendition.attempts < attempt) return true;
  const startedAt = rendition.startedAt?.getTime() ?? 0;
  return now.getTime() - startedAt >= leaseMs;
}

export function startProcessing(
  rendition: DocumentRendition,
  attempt: number,
  now: Date,
): DocumentRendition {
  if (!isInProgress(rendition)) throw new RenditionTransitionError(rendition.status, 'PROCESSING');
  return {
    ...rendition,
    status: 'PROCESSING',
    attempts: Math.max(rendition.attempts, attempt),
    startedAt: now,
    updatedAt: now,
    version: rendition.version + 1,
  };
}

export interface RenderedPdf {
  readonly storageKey: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly pageCount: number;
}

export function markReady(
  rendition: DocumentRendition,
  pdf: RenderedPdf,
  now: Date,
): DocumentRendition {
  if (rendition.status !== 'PROCESSING') {
    throw new RenditionTransitionError(rendition.status, 'READY');
  }
  return {
    ...rendition,
    status: 'READY',
    ...pdf,
    errorCode: null,
    errorMessage: null,
    readyAt: now,
    updatedAt: now,
    version: rendition.version + 1,
  };
}

export function markFailed(
  rendition: DocumentRendition,
  failure: { readonly errorCode: string; readonly errorMessage: string },
  now: Date,
): DocumentRendition {
  if (!isInProgress(rendition)) throw new RenditionTransitionError(rendition.status, 'FAILED');
  return {
    ...rendition,
    status: 'FAILED',
    errorCode: failure.errorCode,
    errorMessage: failure.errorMessage,
    updatedAt: now,
    version: rendition.version + 1,
  };
}

// --- Download (RN-DOC-68/69) ---------------------------------------------------------------------

export type DownloadRefusal = 'NOT_READY' | 'EXPIRED';

/** `null` = pode assinar a URL; senão o motivo do 409 `RENDITION_NOT_READY`. */
export function downloadRefusal(rendition: DocumentRendition, now: Date): DownloadRefusal | null {
  if (rendition.status === 'EXPIRED') return 'EXPIRED';
  if (rendition.status !== 'READY' || rendition.storageKey === null) return 'NOT_READY';
  if (
    rendition.kind === 'PREVIEW' &&
    (rendition.expiresAt === null || rendition.expiresAt.getTime() <= now.getTime())
  ) {
    return 'EXPIRED';
  }
  return null;
}

/** Reaproveitamento (FA-01): a equivalente que não falhou devolve 200 em vez de gerar outra. */
export function isReusable(rendition: DocumentRendition): boolean {
  return rendition.status !== 'FAILED' && rendition.status !== 'EXPIRED';
}

/** Nome do arquivo baixado (`Content-Disposition`): código do documento + tipo. */
export function downloadFileName(
  rendition: Pick<DocumentRendition, 'kind'>,
  document: { readonly code: string | null; readonly versionNumber: number | null },
): string {
  const base = (document.code ?? 'documento').replaceAll('/', '-');
  if (rendition.kind === 'PREVIEW') return `${base}-previa.pdf`;
  const version = document.versionNumber === null ? '' : `-v${String(document.versionNumber)}`;
  return rendition.kind === 'APPROVAL_STAMPED'
    ? `${base}${version}-aprovado.pdf`
    : `${base}${version}.pdf`;
}

// --- Classificação de erro (RN-DOC-66) -----------------------------------------------------------

export type RenderErrorClass = 'TRANSIENT' | 'DEPENDENCY_DOWN' | 'PERMANENT';

/** Códigos internos de falha (`errorCode` — nunca exibidos ao usuário). */
export const RENDER_ERROR_CODES = {
  SNAPSHOT_MISSING: 'SNAPSHOT_MISSING',
  TEMPLATE_INVALID: 'TEMPLATE_INVALID',
  RENDERER_REJECTED: 'RENDERER_REJECTED',
  RENDERER_UNAVAILABLE: 'RENDERER_UNAVAILABLE',
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  INVALID_PDF: 'INVALID_PDF',
  UNKNOWN: 'UNKNOWN',
} as const;
export type RenderErrorCode = (typeof RENDER_ERROR_CODES)[keyof typeof RENDER_ERROR_CODES];

/** Mensagem sanitizada gravada em `errorMessage` (sem conteúdo, valores nem detalhes técnicos). */
export const RENDER_ERROR_MESSAGES: Readonly<Record<RenderErrorCode, string>> = {
  SNAPSHOT_MISSING: 'A versão ou o rascunho do documento não foi encontrado.',
  TEMPLATE_INVALID: 'O layout do template do documento é inválido.',
  RENDERER_REJECTED: 'O conversor recusou o conteúdo gerado.',
  RENDERER_UNAVAILABLE: 'O conversor de PDF ficou indisponível.',
  STORAGE_UNAVAILABLE: 'O armazenamento ficou indisponível.',
  INVALID_PDF: 'O conversor devolveu um PDF inválido.',
  UNKNOWN: 'Falha inesperada ao gerar o PDF.',
};

/**
 * RN-DOC-66: HTTP do conversor. 5xx, 429 e 408 (sobrecarga/timeout) são transitórios; os demais
 * 4xx são entrada inválida (permanente, sem nova tentativa).
 */
export function classifyRendererStatus(
  status: number,
): Exclude<RenderErrorClass, 'DEPENDENCY_DOWN'> {
  if (status >= 500 || status === 429 || status === 408) return 'TRANSIENT';
  return 'PERMANENT';
}
