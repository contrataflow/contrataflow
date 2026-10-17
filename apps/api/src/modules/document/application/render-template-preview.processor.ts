import type { TemplatePreviewErrorCode } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import { StorageKeyBuilder } from '#shared/storage/storage-keys.js';
import { StorageService } from '#shared/storage/storage.service.js';

import { PdfRenderPipeline, RendererCircuitOpenError } from './pdf-render-pipeline.js';
import { DOCUMENT_CLOCK, DOCUMENT_TRANSACTIONS } from './ports.js';
import type { DocumentClock, DocumentTransactions } from './ports.js';
import { recordRender } from './rendition-telemetry.js';
import {
  PdfRendererRejectedError,
  PdfRendererUnavailableError,
  RENDITION_SETTINGS,
} from './rendition.ports.js';
import type { RenditionSettings } from './rendition.ports.js';
import { TemplateContext } from './template-context.js';
import { TemplateLogoService } from './template-logo.js';
import { activeKeyOf, TemplatePreviewStore } from './template-preview.store.js';
import { TEMPLATE_REPOSITORY } from './template.ports.js';
import type { TemplateRepository } from './template.ports.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import { buildRenditionHtml, InvalidLayoutError } from '../domain/rendition-html.js';
import type { RenditionHtmlInput } from '../domain/rendition-html.js';
import {
  previewFailed,
  previewReady,
  previewSnapshot,
  startPreview,
} from '../domain/template-preview.js';
import type { TemplatePreview } from '../domain/template-preview.js';

/*
 * `TemplatePreviewJob` (US-109 · RN-TPL-25/26 · FA-03): renderiza a prévia efêmera do template pelo
 * MESMO pipeline do `document-render` (US-067 — HTML de `buildRenditionHtml`, disjuntor e Gotenberg
 * de `PdfRenderPipeline`); muda só a origem — o layout e as seções da versão do template no momento
 * da geração, com `defaultContent` (ou o espaço reservado), dados reais do tenant/usuário e exemplos
 * de `process.*`/`document.*` — e o destino: o PDF vai para `template-previews/` no bucket
 * `renditions` (tag `ephemeral`) e o estado, para o Redis. Sempre com a marca d'água "RASCUNHO"
 * (`kind = PREVIEW`), sem hash no rodapé (não há versão de documento — RN-TPL-24).
 *
 * Uma tentativa: qualquer falha deixa a prévia `FAILED` com `errorCode` (Gotenberg/disjuntor/
 * storage → `DEPENDENCY_UNAVAILABLE`) e o usuário tenta de novo. Nunca em log: HTML, cabeçalho,
 * rodapé, seções.
 */

export type TemplatePreviewOutcome = 'READY' | 'FAILED' | 'SKIPPED';

const PREVIEW_KIND = 'TEMPLATE_PREVIEW';

/** Os bytes devolvidos não são um PDF utilizável. */
class InvalidPdfError extends Error {}

/** Falha ao gravar o PDF no bucket `renditions`. */
class StorageUnavailableError extends Error {}

/** A versão do template sumiu entre o pedido e o job. */
class TemplateVersionGoneError extends Error {}

function errorCodeOf(error: unknown): TemplatePreviewErrorCode {
  if (
    error instanceof RendererCircuitOpenError ||
    error instanceof PdfRendererUnavailableError ||
    error instanceof StorageUnavailableError
  ) {
    return 'DEPENDENCY_UNAVAILABLE';
  }
  if (error instanceof InvalidLayoutError) return 'TEMPLATE_INVALID';
  if (error instanceof PdfRendererRejectedError) return 'RENDERER_REJECTED';
  if (error instanceof InvalidPdfError) return 'INVALID_PDF';
  return 'UNKNOWN';
}

@Injectable()
export class RenderTemplatePreviewProcessor {
  private readonly logger = new Logger('TemplatePreview');

  constructor(
    @Inject(TEMPLATE_REPOSITORY) private readonly templates: TemplateRepository,
    @Inject(DOCUMENT_TRANSACTIONS) private readonly transactions: DocumentTransactions,
    @Inject(DOCUMENT_CLOCK) private readonly clock: DocumentClock,
    @Inject(RENDITION_SETTINGS) private readonly settings: RenditionSettings,
    private readonly store: TemplatePreviewStore,
    private readonly pipeline: PdfRenderPipeline,
    private readonly storage: StorageService,
    private readonly templateContext: TemplateContext,
    private readonly tenancy: TenancyFacade,
    private readonly identity: IdentityFacade,
    private readonly logos: TemplateLogoService,
  ) {}

  async process(renditionId: string): Promise<TemplatePreviewOutcome> {
    const current = await this.store.find(renditionId);
    const claimed = current === null ? null : startPreview(current, this.clock());
    if (claimed === null) {
      this.logger.log(
        { event: 'template_preview.skipped', renditionId, status: current?.status ?? null },
        'template_preview.skipped',
      );
      return 'SKIPPED';
    }
    await this.store.save(claimed);

    let ready: TemplatePreview;
    try {
      ready = await this.render(claimed);
    } catch (error) {
      return this.fail(claimed, error);
    }
    await this.store.save(ready);
    await this.store.releaseActive(activeKeyOf(ready), ready.renditionId);
    const durationMs = this.sinceRequest(ready);
    recordRender(PREVIEW_KIND, 'READY', durationMs);
    this.logger.log(
      {
        event: 'template_preview.ready',
        templateVersionId: ready.templateVersionId,
        renditionId: ready.renditionId,
        durationMs,
        pageCount: ready.pageCount,
      },
      'template_preview.ready',
    );
    return 'READY';
  }

  private async render(claimed: TemplatePreview): Promise<TemplatePreview> {
    const input = await this.transactions.read((tx) => this.source(tx, claimed));
    const { bytes, facts } = await this.pipeline.convert(buildRenditionHtml(input));
    if (facts === null) throw new InvalidPdfError();
    const storageKey = StorageKeyBuilder.templatePreview(
      claimed.templateVersionId,
      claimed.renditionId,
    );
    try {
      await this.storage.putObject({
        ref: { bucket: 'renditions', key: storageKey },
        body: bytes,
        contentType: 'application/pdf',
        sha256: facts.sha256,
        metadata: {
          'cf-tenant-id': claimed.tenantId,
          'cf-rendition-id': claimed.renditionId,
          'cf-sha256': facts.sha256,
          'cf-schema': '1',
        },
        tags: { 'cf-retention': 'ephemeral' },
      });
    } catch (error) {
      throw new StorageUnavailableError('storage', { cause: error });
    }
    return previewReady(claimed, { storageKey, ...facts }, this.clock());
  }

  /** O HTML da amostra a partir da versão do template no momento da geração (RN-TPL-27). */
  private async source(tx: TenantTx, claimed: TemplatePreview): Promise<RenditionHtmlInput> {
    const version = await this.templates.findVersionById(tx, claimed.templateVersionId);
    const template = version ? await this.templates.findById(tx, version.templateId) : null;
    if (!version || !template) throw new TemplateVersionGoneError();
    const catalog = await this.templateContext.catalog();
    const organizationId = await this.tenancy.primaryOrganizationId(tx);
    const organization =
      organizationId === null ? null : await this.tenancy.organizationSummary(tx, organizationId);
    const names =
      claimed.requestedById === null
        ? new Map<string, string>()
        : await this.identity.userDisplayNames(tx, [claimed.requestedById]);
    const now = this.clock();
    return {
      kind: 'PREVIEW',
      snapshot: previewSnapshot({
        templateId: template.id,
        templateVersionId: version.id,
        templateName: template.name,
        documentType: this.templateContext.typeOf(catalog, template),
        versionNumber: version.versionNumber,
        sections: version.sections,
        organizationName: organization?.name ?? null,
        organizationCnpj: organization?.cnpj ?? null,
        now,
      }),
      template: { sections: version.sections, layout: version.layout },
      contentHash: null,
      tenantName: organization?.name ?? null,
      requesterName:
        claimed.requestedById === null ? null : (names.get(claimed.requestedById) ?? null),
      now,
      timeZone: this.settings.timeZone,
      logo: await this.logos.load(tx, version.layout),
    };
  }

  private async fail(claimed: TemplatePreview, error: unknown): Promise<TemplatePreviewOutcome> {
    const errorCode = errorCodeOf(error);
    const failed = previewFailed(claimed, errorCode);
    await this.store.save(failed);
    await this.store.releaseActive(activeKeyOf(failed), failed.renditionId);
    const durationMs = this.sinceRequest(failed);
    recordRender(PREVIEW_KIND, 'FAILED', durationMs);
    if (errorCode === 'DEPENDENCY_UNAVAILABLE') {
      this.logger.warn(
        {
          event: 'template_preview.gotenberg_unavailable',
          renditionId: failed.renditionId,
          dependency: error instanceof StorageUnavailableError ? 'storage' : 'gotenberg',
        },
        'template_preview.gotenberg_unavailable',
      );
    }
    this.logger.error(
      {
        event: 'template_preview.failed',
        templateVersionId: failed.templateVersionId,
        renditionId: failed.renditionId,
        durationMs,
        errorCode,
        errorClass: error instanceof Error ? error.name : 'unknown',
      },
      'template_preview.failed',
    );
    return 'FAILED';
  }

  private sinceRequest(preview: TemplatePreview): number {
    return Math.max(0, this.clock().getTime() - preview.requestedAt.getTime());
  }
}
