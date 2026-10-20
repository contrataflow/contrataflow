import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { TENANT_STATUS_PORT } from '#shared/auth/ports.js';
import type { TenantStatusPort } from '#shared/auth/ports.js';
import { TenantJob } from '#shared/jobs/tenant-job.js';

import { DOCUMENT_RENDER_QUEUE } from './render-document.job.js';
import { RenderTemplatePreviewProcessor } from './render-template-preview.processor.js';

/*
 * Handler do job `document-render/template-preview` (US-109 · RN-TPL-25): a mesma fila e o mesmo
 * Gotenberg do PDF dos documentos (US-067), com a origem "TEMPLATE" — o rascunho/versão do template
 * em vez de uma `DocumentVersion`. `jobId` = `renditionId`; a base `TenantJob` restaura o tenant
 * (RLS, Redis e storage) e o ator — quem pediu a prévia.
 */

export const TEMPLATE_PREVIEW_JOB = 'template-preview';

const payloadSchema = z.strictObject({
  renditionId: z.uuid(),
  templateVersionId: z.uuid(),
});
export type TemplatePreviewJobPayload = z.infer<typeof payloadSchema>;

@Injectable()
export class RenderTemplatePreviewJob extends TenantJob<TemplatePreviewJobPayload> {
  readonly queue = DOCUMENT_RENDER_QUEUE;
  readonly name = TEMPLATE_PREVIEW_JOB;
  protected readonly payloadSchema = payloadSchema;

  constructor(
    @Inject(TENANT_STATUS_PORT) tenants: TenantStatusPort,
    private readonly processor: RenderTemplatePreviewProcessor,
  ) {
    super(tenants);
  }

  protected async handle(payload: TemplatePreviewJobPayload): Promise<void> {
    await this.processor.process(payload.renditionId);
  }
}
