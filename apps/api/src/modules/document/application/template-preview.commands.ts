import type { TemplatePreviewRequestedDto } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import { ApiError } from '#shared/errors/api-error.js';
import { JOB_QUEUE } from '#shared/jobs/job-queue.js';
import type { JobQueuePort } from '#shared/jobs/job-queue.js';

import { DOCUMENT_CLOCK, DOCUMENT_TRANSACTIONS } from './ports.js';
import type { DocumentClock, DocumentTransactions } from './ports.js';
import { DOCUMENT_RENDER_QUEUE, RENDER_PRIORITY } from './render-document.job.js';
import { TEMPLATE_PREVIEW_JOB } from './render-template-preview.job.js';
import { TemplateContext } from './template-context.js';
import { activeKeyOf, TemplatePreviewStore } from './template-preview.store.js';
import type { ActivePreviewKey } from './template-preview.store.js';
import {
  templateInvalid,
  templatePreviewUnavailable,
  templateVersionNotFound,
} from './template.errors.js';
import { TEMPLATE_REPOSITORY } from './template.ports.js';
import type { TemplateRepository } from './template.ports.js';
import { FULL_VALIDATION, validateTemplateContent } from '../domain/template-content.validator.js';
import {
  isPreviewInProgress,
  previewFailed,
  requestTemplatePreview,
} from '../domain/template-preview.js';
import type { TemplatePreview } from '../domain/template-preview.js';

/*
 * `RenderTemplatePreviewCommand` — TPL-09 (US-109 · RN-TPL-25..27 · FA-01/FA-03):
 *
 *   leitura (transação curta): versão do tenant (404) em qualquer estado — `TEMPLATE_VIEW` gera a
 *     prévia de versões publicadas/aposentadas —, conteúdo conferido por inteiro pelo
 *     `TemplateContentValidator` (422 `TEMPLATE_INVALID` — V-08);
 *   deduplicação: o mesmo usuário, para a mesma revisão (ETag) da versão, recebe a prévia em
 *     andamento (Gherkin "[Duplicidade]"; trava `SET NX` no Redis);
 *   estado `PENDING` no Redis (TTL 24 h) e o job `document-render/template-preview` com
 *     `jobId = renditionId`, prioridade de prévia e UMA tentativa (o usuário tenta de novo — FA-03).
 *
 * Nenhuma auditoria (consulta/visualização). Redis fora → 503; fila fora → a prévia já nasce
 * `FAILED` (`DEPENDENCY_UNAVAILABLE`) e a resposta continua 202 — falha de renderização é estado da
 * prévia, não erro HTTP desta chamada.
 */

export interface TemplatePreviewRequestResult {
  readonly preview: TemplatePreview;
  /** `true` = a prévia em andamento do mesmo pedido (sem novo job). */
  readonly reused: boolean;
}

@Injectable()
export class RenderTemplatePreviewCommand {
  private readonly logger = new Logger('TemplatePreview');

  constructor(
    @Inject(TEMPLATE_REPOSITORY) private readonly templates: TemplateRepository,
    @Inject(DOCUMENT_TRANSACTIONS) private readonly transactions: DocumentTransactions,
    @Inject(DOCUMENT_CLOCK) private readonly clock: DocumentClock,
    @Inject(JOB_QUEUE) private readonly jobs: JobQueuePort,
    private readonly templateContext: TemplateContext,
    private readonly store: TemplatePreviewStore,
  ) {}

  async execute(versionId: string): Promise<TemplatePreviewRequestResult> {
    const context = requireRequestContext();
    const catalog = await this.templateContext.catalog();
    const version = await this.transactions.read(async (tx) => {
      const found = await this.templates.findVersionById(tx, versionId);
      if (!found) throw templateVersionNotFound();
      const template = await this.templates.findById(tx, found.templateId);
      if (!template) throw templateVersionNotFound();
      const documentType = this.templateContext.typeOf(catalog, template);
      const importSources = await this.templateContext.importSourcesFor(tx, catalog, documentType);
      const violations = validateTemplateContent(
        found,
        { documentType, importSources },
        FULL_VALIDATION,
      );
      if (violations.length > 0) throw templateInvalid(violations);
      return found;
    });

    const preview = requestTemplatePreview({
      renditionId: newId(),
      tenantId: version.tenantId,
      templateVersionId: version.id,
      templateVersionRevision: version.version,
      requestedById: context.actor.userId,
      now: this.clock(),
    });
    const key = activeKeyOf(preview);
    let result: TemplatePreviewRequestResult;
    try {
      const running = await this.running(key, preview.renditionId);
      result = running ? { preview: running, reused: true } : { preview, reused: false };
      if (!result.reused) await this.store.save(preview);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw templatePreviewUnavailable(error);
    }
    if (!result.reused) result = { preview: await this.enqueue(preview, key), reused: false };

    this.logger.log(
      {
        event: 'template_preview.requested',
        templateVersionId: version.id,
        renditionId: result.preview.renditionId,
        reused: result.reused,
        correlationId: context.correlationId,
      },
      'template_preview.requested',
    );
    return result;
  }

  /** A prévia em andamento do mesmo pedido, ou `null` (esta passa a ser a em andamento). */
  private async running(key: ActivePreviewKey, renditionId: string) {
    if (await this.store.claimActive(key, renditionId)) return null;
    const activeId = await this.store.activeOf(key);
    const active = activeId === null ? null : await this.store.find(activeId);
    if (active !== null && isPreviewInProgress(active)) return active;
    // Trava de uma prévia já concluída (ou vencida): esta assume.
    await this.store.replaceActive(key, renditionId);
    return null;
  }

  private async enqueue(preview: TemplatePreview, key: ActivePreviewKey): Promise<TemplatePreview> {
    try {
      await this.jobs.enqueue(
        DOCUMENT_RENDER_QUEUE,
        TEMPLATE_PREVIEW_JOB,
        { renditionId: preview.renditionId, templateVersionId: preview.templateVersionId },
        { jobId: preview.renditionId, priority: RENDER_PRIORITY.PREVIEW, attempts: 1 },
      );
      return preview;
    } catch (error) {
      const failed = previewFailed(preview, 'DEPENDENCY_UNAVAILABLE');
      this.logger.warn(
        {
          event: 'template_preview.failed',
          templateVersionId: preview.templateVersionId,
          renditionId: preview.renditionId,
          errorCode: failed.errorCode,
          cause: error instanceof Error ? error.name : 'unknown',
        },
        'template_preview.failed',
      );
      try {
        await this.store.save(failed);
        await this.store.releaseActive(key, preview.renditionId);
      } catch (storeError) {
        throw templatePreviewUnavailable(storeError);
      }
      return failed;
    }
  }
}

/** Resposta 202 de TPL-09. */
export function toPreviewRequestedDto(preview: TemplatePreview): TemplatePreviewRequestedDto {
  return { renditionId: preview.renditionId };
}
