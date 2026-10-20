import { currentJobLogFields } from '@contrataflow/observability';
import { RENDITION_KINDS } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { TENANT_STATUS_PORT } from '#shared/auth/ports.js';
import type { TenantStatusPort } from '#shared/auth/ports.js';
import { TenantJob } from '#shared/jobs/tenant-job.js';

import { RenderDocumentProcessor } from './render-document.processor.js';
import { RENDITION_SETTINGS } from './rendition.ports.js';
import type { RenditionSettings } from './rendition.ports.js';
import type { DocumentRendition } from '../domain/document-rendition.js';

/*
 * Handler do job `document-render/render` (queues.md §4.4 · US-067): `jobId` = `renditionId`
 * (padrão B). A base `TenantJob` valida `meta`/payload, ignora tenant fora de `ACTIVE` e restaura
 * o contexto do tenant (RLS) e do ator — quem pediu o PDF — antes do processador, que é idempotente
 * pela trava condicional de `PROCESSING`. O mascaramento (POL-09) já vem decidido na linha.
 */

export const DOCUMENT_RENDER_QUEUE = 'document-render';
export const DOCUMENT_RENDER_JOB = 'render';

/** queues.md §4.4: prévia = 1 (usuário esperando); versão/selo = 5; lote = 10. */
export const RENDER_PRIORITY = { PREVIEW: 1, VERSION: 5, BATCH: 10 } as const;

const payloadSchema = z.strictObject({
  renditionId: z.uuid(),
  documentId: z.uuid(),
  kind: z.enum(RENDITION_KINDS),
  documentVersionId: z.uuid().optional(),
  draftRevision: z.int().min(0).optional(),
  approvalId: z.uuid().optional(),
});
export type RenderJobPayload = z.infer<typeof payloadSchema>;

/** Payload do contrato de queues.md §4.4 (só IDs — nada de conteúdo). */
export function renderJobPayload(rendition: DocumentRendition): RenderJobPayload {
  return {
    renditionId: rendition.id,
    documentId: rendition.documentId,
    kind: rendition.kind,
    ...(rendition.documentVersionId === null
      ? {}
      : { documentVersionId: rendition.documentVersionId }),
    ...(rendition.draftRevision === null ? {} : { draftRevision: rendition.draftRevision }),
    ...(rendition.approvalId === null ? {} : { approvalId: rendition.approvalId }),
  };
}

@Injectable()
export class RenderDocumentJob extends TenantJob<RenderJobPayload> {
  readonly queue = DOCUMENT_RENDER_QUEUE;
  readonly name = DOCUMENT_RENDER_JOB;
  protected readonly payloadSchema = payloadSchema;

  constructor(
    @Inject(TENANT_STATUS_PORT) tenants: TenantStatusPort,
    @Inject(RENDITION_SETTINGS) private readonly settings: RenditionSettings,
    private readonly processor: RenderDocumentProcessor,
  ) {
    super(tenants);
  }

  protected async handle(payload: RenderJobPayload): Promise<void> {
    const attempt = currentJobLogFields()?.attempt;
    const current = typeof attempt === 'number' ? attempt : 1;
    await this.processor.process({
      renditionId: payload.renditionId,
      attempt: current,
      lastAttempt: current >= this.settings.attempts,
    });
  }
}
