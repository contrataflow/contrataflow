import type { DocumentSnapshot } from '@contrataflow/validation';
import { DocumentRenditionFailed, DocumentRenditionReady } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';
import { StorageKeyBuilder } from '#shared/storage/storage-keys.js';
import { StorageService } from '#shared/storage/storage.service.js';

import { DocumentLifecycleService } from './document-lifecycle.service.js';
import { PdfRenderPipeline, RendererCircuitOpenError } from './pdf-render-pipeline.js';
import { PdfRendererCircuit } from './pdf-renderer-circuit.js';
import { DOCUMENT_CLOCK, DOCUMENT_TRANSACTIONS } from './ports.js';
import type { DocumentClock, DocumentTransactions } from './ports.js';
import { recordRender } from './rendition-telemetry.js';
import {
  DOCUMENT_RENDITION_REPOSITORY,
  PdfRendererRejectedError,
  PdfRendererUnavailableError,
  RENDITION_SETTINGS,
} from './rendition.ports.js';
import type { DocumentRenditionRepository, RenditionSettings } from './rendition.ports.js';
import { TemplateLogoService } from './template-logo.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { maskConfidentialSnapshot } from '../domain/confidential-snapshot.js';
import {
  canClaim,
  markFailed,
  markReady,
  RENDER_ERROR_CODES,
  RENDER_ERROR_MESSAGES,
  startProcessing,
} from '../domain/document-rendition.js';
import type {
  DocumentRendition,
  RenderedPdf,
  RenderErrorClass,
  RenderErrorCode,
} from '../domain/document-rendition.js';
import { buildRenditionHtml, InvalidLayoutError } from '../domain/rendition-html.js';
import type { RenditionHtmlInput } from '../domain/rendition-html.js';

/*
 * `RenderDocumentHandler` do `document-render` (US-067 · RN-DOC-65..67 · ADR-007 · queues.md §4.4),
 * em três passos — nenhuma chamada ao Gotenberg/S3 dentro de transação:
 *
 *   1. Trava (transação curta): `PENDING` → `PROCESSING`, ou `PROCESSING` de tentativa anterior/trava
 *      vencida, por gravação condicional (versão lida). Duas entregas da mesma tentativa → só uma
 *      assume; a outra conclui sem efeito. Disjuntor ABERTO antes da trava → pausa sem tocar a linha
 *      nem consumir tentativa (FA-03).
 *   2. Renderização (fora de transação): snapshot da versão (`CONTENT`/`APPROVAL_STAMPED`) ou do
 *      rascunho atual (`PREVIEW`), POL-09 já decidido na linha (`masked`), HTML sanitizado com o
 *      `LayoutDefinition`, Gotenberg, conferência do PDF (SHA-256/tamanho/páginas) e gravação no
 *      bucket `renditions` com a tag de retenção.
 *   3. Resultado (transação curta, SE a trava ainda é desta execução): `READY` +
 *      `DocumentRenditionReady`; falha permanente ou última tentativa → `FAILED` + `errorCode` +
 *      mensagem sanitizada + `DocumentRenditionFailed` (notificação `DOCUMENT_RENDER_FAILED`) e o
 *      erro segue para a fila (cópia na `dead-letter`).
 *
 * Nunca em log: HTML, valores monetários, texto das seções.
 */

export type RenderOutcome = 'READY' | 'FAILED' | 'SKIPPED';

export interface RenderDocumentInput {
  readonly renditionId: string;
  /** Tentativa do job (começa em 1). */
  readonly attempt: number;
  /** Última tentativa da política da fila: a falha transitória vira `FAILED`. */
  readonly lastAttempt?: boolean;
}

/**
 * Gotenberg com o disjuntor aberto: o job pausa e volta SEM consumir tentativa (queues.md §10.3);
 * a rendition continua `PENDING`/`PROCESSING` ("Gerando PDF…"). O runtime do worker traduz para
 * o adiamento do job (`consumesAttempt`).
 */
export class RenderDeferredError extends Error {
  readonly consumesAttempt = false;
  readonly dependency = 'gotenberg';

  constructor(readonly retryAfterSeconds: number) {
    super('Renderização adiada: conversor de PDF indisponível.');
    this.name = 'RenderDeferredError';
  }
}

/** Falha transitória antes da última tentativa: a fila tenta de novo com backoff (RN-DOC-66). */
export class RenderRetryableError extends Error {
  readonly consumesAttempt = true;

  constructor(readonly errorCode: RenderErrorCode) {
    super(`Renderização: falha transitória (${errorCode}).`);
    this.name = 'RenderRetryableError';
  }
}

/** A rendition ficou `FAILED` (RN-DOC-67): falha final do job → cópia na `dead-letter`. */
export class RenderFailedError extends Error {
  readonly permanent = true;

  constructor(readonly errorCode: RenderErrorCode) {
    super(`Renderização falhou (${errorCode}).`);
    this.name = 'RenderFailedError';
  }
}

/** Falha classificada durante a renderização. */
class RenderFailure extends Error {
  constructor(
    readonly errorCode: RenderErrorCode,
    readonly errorClass: RenderErrorClass,
    options?: { readonly cause?: unknown },
  ) {
    super(errorCode, options);
    this.name = 'RenderFailure';
  }
}

function classify(error: unknown): RenderFailure {
  if (error instanceof RenderFailure) return error;
  if (error instanceof RendererCircuitOpenError) {
    return new RenderFailure(RENDER_ERROR_CODES.RENDERER_UNAVAILABLE, 'DEPENDENCY_DOWN');
  }
  if (error instanceof InvalidLayoutError) {
    return new RenderFailure(RENDER_ERROR_CODES.TEMPLATE_INVALID, 'PERMANENT');
  }
  if (error instanceof PdfRendererRejectedError) {
    return new RenderFailure(RENDER_ERROR_CODES.RENDERER_REJECTED, 'PERMANENT');
  }
  if (error instanceof PdfRendererUnavailableError) {
    return new RenderFailure(RENDER_ERROR_CODES.RENDERER_UNAVAILABLE, 'TRANSIENT', {
      cause: error,
    });
  }
  // Banco, storage ou o desconhecido: transitórios até esgotar (queues.md §10.2).
  return new RenderFailure(RENDER_ERROR_CODES.UNKNOWN, 'TRANSIENT', { cause: error });
}

const PDF_CONTENT_TYPE = 'application/pdf';

@Injectable()
export class RenderDocumentProcessor {
  private readonly logger = new Logger('RenderDocumentHandler');

  constructor(
    @Inject(DOCUMENT_TRANSACTIONS) private readonly transactions: DocumentTransactions,
    @Inject(DOCUMENT_RENDITION_REPOSITORY) private readonly renditions: DocumentRenditionRepository,
    @Inject(DOCUMENT_CLOCK) private readonly clock: DocumentClock,
    @Inject(RENDITION_SETTINGS) private readonly settings: RenditionSettings,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly pipeline: PdfRenderPipeline,
    private readonly circuit: PdfRendererCircuit,
    private readonly storage: StorageService,
    private readonly lifecycle: DocumentLifecycleService,
    private readonly identity: IdentityFacade,
    private readonly logos: TemplateLogoService,
  ) {}

  async process(input: RenderDocumentInput): Promise<RenderOutcome> {
    if (this.circuit.state === 'OPEN') throw this.deferred(input, null);
    const claimed = await this.claim(input);
    if (claimed === null) return 'SKIPPED';

    let pdf: RenderedPdf;
    try {
      pdf = await this.render(claimed);
    } catch (error) {
      const failure = classify(error);
      if (failure.errorClass === 'DEPENDENCY_DOWN') {
        await this.release(claimed);
        throw this.deferred(input, claimed);
      }
      if (failure.errorClass === 'PERMANENT' || input.lastAttempt === true) {
        const outcome = await this.fail(claimed, failure.errorCode);
        if (outcome === 'SKIPPED') return outcome;
        throw new RenderFailedError(failure.errorCode);
      }
      this.logRetry(claimed, input.attempt, failure);
      throw new RenderRetryableError(failure.errorCode);
    }
    return this.complete(claimed, pdf);
  }

  /** Passo 1: trava condicional. `null` = nada a fazer (outra entrega assumiu, ou já terminou). */
  private claim(input: RenderDocumentInput): Promise<DocumentRendition | null> {
    return this.transactions.run(async (tx) => {
      const current = await this.renditions.findById(tx, input.renditionId);
      const now = this.clock();
      if (current === null || !canClaim(current, input.attempt, now, this.settings.leaseMs)) {
        this.logger.log(
          {
            event: 'document.render_skipped',
            renditionId: input.renditionId,
            status: current?.status ?? null,
            attempt: input.attempt,
          },
          'document.render_skipped',
        );
        return null;
      }
      const next = startProcessing(current, input.attempt, now);
      return (await this.renditions.update(tx, next, current.version)) ? next : null;
    });
  }

  /** Devolve a trava (segue `PROCESSING`, trava vencida): a mesma tentativa pode reassumir. */
  private async release(claimed: DocumentRendition): Promise<void> {
    await this.transactions.run(async (tx) => {
      const current = await this.renditions.findById(tx, claimed.id);
      if (current?.version !== claimed.version) return;
      await this.renditions.update(
        tx,
        { ...current, startedAt: null, updatedAt: this.clock(), version: current.version + 1 },
        current.version,
      );
    });
  }

  /** Passo 2: snapshot → HTML → Gotenberg → conferência → bucket `renditions`. */
  private async render(claimed: DocumentRendition): Promise<RenderedPdf> {
    const source = await this.transactions.read((tx) => this.source(tx, claimed));
    const html = buildRenditionHtml(source.input);
    const { bytes, facts } = await this.pipeline.convert(html);
    if (facts === null) throw new RenderFailure(RENDER_ERROR_CODES.INVALID_PDF, 'PERMANENT');
    const storageKey = this.storageKeyOf(claimed, source.versionNumber);
    try {
      await this.storage.putObject({
        ref: { bucket: 'renditions', key: storageKey },
        body: bytes,
        contentType: PDF_CONTENT_TYPE,
        sha256: facts.sha256,
        metadata: {
          'cf-tenant-id': claimed.tenantId,
          'cf-rendition-id': claimed.id,
          'cf-sha256': facts.sha256,
          'cf-schema': '1',
        },
        tags: { 'cf-retention': claimed.kind === 'PREVIEW' ? 'ephemeral' : 'evidence' },
      });
    } catch (error) {
      throw new RenderFailure(RENDER_ERROR_CODES.STORAGE_UNAVAILABLE, 'TRANSIENT', {
        cause: error,
      });
    }
    return { storageKey, ...facts };
  }

  /** O que o HTML precisa, lido numa transação de leitura do tenant (RLS). */
  private async source(
    tx: TenantTx,
    claimed: DocumentRendition,
  ): Promise<{ readonly input: RenditionHtmlInput; readonly versionNumber: number | null }> {
    const missing = () => new RenderFailure(RENDER_ERROR_CODES.SNAPSHOT_MISSING, 'PERMANENT');
    const context = await this.lifecycle.loadInternal(tx, claimed.documentId);
    if (context === null) throw missing();
    const now = this.clock();
    let snapshot: DocumentSnapshot;
    let contentHash: string | null = null;
    let template = context.template;
    let versionNumber: number | null = null;
    if (claimed.kind === 'PREVIEW') {
      snapshot = await this.lifecycle.snapshotOf(
        tx,
        context,
        context.document,
        (context.document.currentVersionNumber ?? 0) + 1,
        now,
      );
    } else {
      const version =
        claimed.documentVersionId === null
          ? null
          : await this.lifecycle.findVersion(tx, claimed.documentVersionId);
      if (!version?.content) throw missing();
      snapshot = version.content;
      contentHash = version.contentHash;
      versionNumber = version.versionNumber;
      template =
        version.templateVersionId === null
          ? null
          : await this.lifecycle.findTemplateVersion(tx, version.templateVersionId);
    }
    const names =
      claimed.requestedById === null
        ? new Map<string, string>()
        : await this.identity.userDisplayNames(tx, [claimed.requestedById]);
    const logo = await this.logos.load(tx, template?.layout ?? null);
    return {
      versionNumber,
      input: {
        logo,
        kind: claimed.kind,
        snapshot: claimed.masked ? maskConfidentialSnapshot(snapshot) : snapshot,
        template:
          template === null ? null : { sections: template.sections, layout: template.layout },
        contentHash,
        tenantName: snapshot.process.organizationName,
        requesterName:
          claimed.requestedById === null ? null : (names.get(claimed.requestedById) ?? null),
        now,
        timeZone: this.settings.timeZone,
      },
    };
  }

  /** storage.md §4: prévia por rendition; versão por nome discriminado (tipo, aprovação, POL-09). */
  private storageKeyOf(claimed: DocumentRendition, versionNumber: number | null): string {
    if (claimed.kind === 'PREVIEW' || versionNumber === null) {
      return StorageKeyBuilder.documentPreview(claimed.documentId, claimed.id);
    }
    const suffix = claimed.masked ? '-masked' : '';
    const fileName =
      claimed.kind === 'APPROVAL_STAMPED'
        ? `approval-stamped-${claimed.approvalId ?? claimed.id}${suffix}.pdf`
        : `content${suffix}.pdf`;
    return StorageKeyBuilder.versionRendition(
      claimed.processId,
      claimed.documentId,
      versionNumber,
      fileName,
    );
  }

  /** Passo 3 (sucesso): `READY` + `DocumentRenditionReady`, se a trava ainda é desta execução. */
  private async complete(claimed: DocumentRendition, pdf: RenderedPdf): Promise<RenderOutcome> {
    const ready = await this.transactions.run(async (tx) => {
      const current = await this.renditions.findById(tx, claimed.id);
      if (current?.version !== claimed.version) return null;
      const next = markReady(current, pdf, this.clock());
      if (!(await this.renditions.update(tx, next, current.version))) return null;
      await this.outbox.record(
        tx,
        DocumentRenditionReady.of({
          aggregateId: next.id,
          processId: next.processId,
          payload: {
            documentId: next.documentId,
            documentVersionId: next.documentVersionId,
            renditionId: next.id,
            kind: next.kind,
            sha256: pdf.sha256,
            pageCount: pdf.pageCount,
          },
        }),
      );
      return next;
    });
    if (ready === null) return 'SKIPPED';
    const durationMs = this.sinceRequest(ready);
    recordRender(ready.kind, 'READY', durationMs);
    this.logger.log(
      {
        event: 'document.render_completed',
        renditionId: ready.id,
        kind: ready.kind,
        durationMs,
        pageCount: pdf.pageCount,
        sizeBytes: pdf.sizeBytes,
      },
      'document.render_completed',
    );
    return 'READY';
  }

  /** Passo 3 (falha final): `FAILED` + mensagem sanitizada + `DocumentRenditionFailed`. */
  private async fail(
    claimed: DocumentRendition,
    errorCode: RenderErrorCode,
  ): Promise<RenderOutcome> {
    const failed = await this.transactions.run(async (tx) => {
      const current = await this.renditions.findById(tx, claimed.id);
      if (current?.version !== claimed.version) return null;
      const next = markFailed(
        current,
        { errorCode, errorMessage: RENDER_ERROR_MESSAGES[errorCode] },
        this.clock(),
      );
      if (!(await this.renditions.update(tx, next, current.version))) return null;
      await this.outbox.record(
        tx,
        DocumentRenditionFailed.of({
          aggregateId: next.id,
          processId: next.processId,
          payload: {
            documentId: next.documentId,
            renditionId: next.id,
            kind: next.kind,
            errorCode,
            attempts: next.attempts,
          },
        }),
      );
      return next;
    });
    if (failed === null) return 'SKIPPED';
    recordRender(failed.kind, 'FAILED', this.sinceRequest(failed));
    this.logger.error(
      {
        event: 'document.render_failed',
        renditionId: failed.id,
        errorCode,
        attempts: failed.attempts,
        correlationId: requireRequestContext().correlationId,
      },
      'document.render_failed',
    );
    return 'FAILED';
  }

  private sinceRequest(rendition: DocumentRendition): number {
    return Math.max(0, this.clock().getTime() - rendition.requestedAt.getTime());
  }

  private logRetry(claimed: DocumentRendition, attempt: number, failure: RenderFailure): void {
    recordRender(claimed.kind, 'RETRY', null);
    const cause = failure.cause;
    this.logger.warn(
      {
        event: 'document.render_retry',
        renditionId: claimed.id,
        attempt,
        errorClass: cause instanceof Error ? cause.name : failure.errorCode,
      },
      'document.render_retry',
    );
  }

  private deferred(
    input: RenderDocumentInput,
    claimed: DocumentRendition | null,
  ): RenderDeferredError {
    recordRender(claimed?.kind ?? 'UNKNOWN', 'DEFERRED', null);
    this.logger.warn(
      {
        event: 'document.render_retry',
        renditionId: input.renditionId,
        attempt: input.attempt,
        errorClass: 'RendererCircuitOpen',
        circuit: this.circuit.state,
      },
      'document.render_retry',
    );
    return new RenderDeferredError(Math.max(1, this.circuit.retryAfterSeconds()));
  }
}
