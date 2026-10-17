import type { LayoutDefinition } from '@contrataflow/validation';

import type { TenantTx } from '#shared/database/prisma.js';

import type { DocumentRendition } from '../domain/document-rendition.js';

/*
 * Portas da renderização em PDF (US-067 · ADR-007): o repositório de `DocumentRendition`
 * (Prisma e memória) e o conversor HTML → PDF (Gotenberg — `infrastructure/gotenberg.client.ts`).
 */

/** Chave de equivalência do reaproveitamento (FA-01): mesma versão, tipo, aprovação e POL-09. */
export interface EquivalentRenditionKey {
  readonly documentVersionId: string;
  readonly kind: 'CONTENT' | 'APPROVAL_STAMPED';
  readonly approvalId: string | null;
  readonly masked: boolean;
}

export interface DocumentRenditionRepository {
  /** @throws `DuplicateRenditionError` se o índice único de `CONTENT`/`APPROVAL_STAMPED` recusar. */
  insert(tx: TenantTx, rendition: DocumentRendition): Promise<void>;
  /** `null` se não existe NO TENANT da transação. */
  findById(tx: TenantTx, id: string): Promise<DocumentRendition | null>;
  /** A equivalente que não falhou (`PENDING`/`PROCESSING`/`READY`), se houver. */
  findEquivalent(tx: TenantTx, key: EquivalentRenditionKey): Promise<DocumentRendition | null>;
  /**
   * Grava a nova versão SE o registro ainda está na versão lida (`UPDATE … WHERE version = $lida`).
   * `false` = outro escreveu antes (perdeu a corrida).
   */
  update(tx: TenantTx, next: DocumentRendition, expectedVersion: number): Promise<boolean>;
}

export const DOCUMENT_RENDITION_REPOSITORY = Symbol('DocumentRenditionRepository');

/** A corrida de dois pedidos equivalentes: o índice único decidiu (o perdedor reaproveita). */
export class DuplicateRenditionError extends Error {
  constructor() {
    super('Já existe uma rendition equivalente.');
    this.name = 'DuplicateRenditionError';
  }
}

export interface PdfRenderRequest {
  readonly indexHtml: string;
  readonly headerHtml: string | null;
  readonly footerHtml: string;
  readonly layout: LayoutDefinition;
}

export interface PdfRendererPort {
  readonly engine: string;
  /**
   * Converte o HTML em PDF. Conexão, timeout, 5xx/429 → `PdfRendererUnavailableError`
   * (transitório); outro 4xx → `PdfRendererRejectedError` (permanente).
   */
  render(request: PdfRenderRequest): Promise<Buffer>;
}

export const PDF_RENDERER = Symbol('PdfRenderer');

/** Gotenberg fora do ar, lento ou sobrecarregado (RN-DOC-66: transitório; alimenta o disjuntor). */
export class PdfRendererUnavailableError extends Error {
  constructor(
    readonly status: number | null,
    options?: { readonly cause?: unknown },
  ) {
    super('Conversor de PDF indisponível.', options);
    this.name = 'PdfRendererUnavailableError';
  }
}

/** Gotenberg recusou a entrada (4xx): permanente, sem nova tentativa (RN-DOC-66). */
export class PdfRendererRejectedError extends Error {
  constructor(readonly status: number) {
    super('Conversor de PDF recusou o conteúdo.');
    this.name = 'PdfRendererRejectedError';
  }
}

/** Parâmetros de plataforma da renderização (queues.md §4.4 · §10.1). */
export interface RenditionSettings {
  /** Tentativas do `document-render` (5) e base do backoff (5 s). */
  readonly attempts: number;
  readonly backoffMs: number;
  /** Trava da renderização: depois disso, outra entrega da mesma tentativa pode assumir (60 s). */
  readonly leaseMs: number;
  /** Fuso para `{{today}}`/`{{document.date}}` (`America/Sao_Paulo` no MVP 1). */
  readonly timeZone: string;
}

export const RENDITION_SETTINGS = Symbol('RenditionSettings');
