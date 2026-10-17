import { RENDITION_MESSAGES } from '@contrataflow/validation';
import type { RenditionRequest } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { DocumentApprovalRegistry } from '#shared/document/document-approval.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';
import { JOB_QUEUE } from '#shared/jobs/job-queue.js';
import type { JobQueuePort } from '#shared/jobs/job-queue.js';

import { DocumentLifecycleService } from './document-lifecycle.service.js';
import type { DocumentContext } from './document-lifecycle.service.js';
import { DOCUMENT_CLOCK, DOCUMENT_TRANSACTIONS } from './ports.js';
import type { DocumentClock, DocumentTransactions } from './ports.js';
import {
  DOCUMENT_RENDER_JOB,
  DOCUMENT_RENDER_QUEUE,
  RENDER_PRIORITY,
  renderJobPayload,
} from './render-document.job.js';
import { RenditionAccess, renditionNotFound, uploadedNotRenderable } from './rendition-access.js';
import {
  DOCUMENT_RENDITION_REPOSITORY,
  DuplicateRenditionError,
  RENDITION_SETTINGS,
} from './rendition.ports.js';
import type { DocumentRenditionRepository, RenditionSettings } from './rendition.ports.js';
import {
  isReusable,
  requestPreview,
  requestVersionRendition,
} from '../domain/document-rendition.js';
import type { DocumentRendition } from '../domain/document-rendition.js';

/*
 * DOC-20/DOC-21 — Pedir um PDF (US-067 · RN-DOC-63/64 · padrão B de queues.md §3):
 *
 *   handle (UMA transação): documento visível (DEC-024 — 404) e não externo; POL-09 decide se o PDF
 *     sai mascarado; `DocumentRendition` `PENDING` (`requestedById`, `requestedAt`, revisão do
 *     rascunho ou versão) + auditoria `document.render_request`.
 *   depois do commit: enfileira `document-render` com `jobId = renditionId` (prévia com prioridade
 *     1; versão, 5). Fila fora → a linha fica `PENDING` e o reconciliador reenfileira; a resposta
 *     continua 202.
 *
 * DOC-21 é idempotente por natureza (FA-01): a equivalente que não falhou (mesma versão, tipo,
 * aprovação e forma de POL-09) volta com 200, sem novo job; o índice único parcial decide a corrida
 * de dois pedidos simultâneos (o perdedor relê e reaproveita). Prévias nunca se reaproveitam: cada
 * clique gera a sua (Gherkin "[Concorrência]").
 */

export interface RenditionRequestResult {
  readonly rendition: DocumentRendition;
  /** `true` = equivalente existente (200); `false` = criada agora (202). */
  readonly reused: boolean;
}

function requesterId(): string {
  const userId = requireRequestContext().actor.userId;
  if (userId === null) throw new ApiError('UNAUTHENTICATED');
  return userId;
}

abstract class RenditionRequestCommand<I> extends TransactionalCommandHandler<
  I,
  null,
  RenditionRequestResult
> {
  protected constructor(
    commandName: string,
    transactions: DocumentTransactions,
    protected readonly renditions: DocumentRenditionRepository,
    protected readonly clock: DocumentClock,
    protected readonly settings: RenditionSettings,
    protected readonly audit: AuditTrailPort,
    protected readonly jobs: JobQueuePort,
    protected readonly lifecycle: DocumentLifecycleService,
    protected readonly access: RenditionAccess,
  ) {
    super(commandName, transactions);
  }

  override async execute(input: I): Promise<RenditionRequestResult> {
    let result: RenditionRequestResult;
    try {
      result = await super.execute(input);
    } catch (error) {
      // Corrida de dois pedidos equivalentes: o índice único decidiu; a nova leitura reaproveita.
      if (!(error instanceof DuplicateRenditionError)) throw error;
      result = await super.execute(input);
    }
    // Sem novo job para a equivalente já em andamento ou pronta; `PENDING` reaproveitada pode ter
    // perdido o job (fila fora no pedido original) — o `jobId` deduplica.
    if (!result.reused || result.rendition.status === 'PENDING')
      await this.enqueue(result.rendition);
    return result;
  }

  protected prepare(): Promise<null> {
    return Promise.resolve(null);
  }

  protected async record(
    tx: TenantTx,
    context: DocumentContext,
    rendition: DocumentRendition,
    reused: boolean,
  ): Promise<void> {
    await this.audit.record(tx, {
      action: 'document.render_request',
      entityType: 'DocumentRendition',
      entityId: rendition.id,
      processId: context.document.processId,
      metadata: {
        renditionId: rendition.id,
        documentId: rendition.documentId,
        kind: rendition.kind,
        ...(rendition.documentVersionId === null
          ? {}
          : { documentVersionId: rendition.documentVersionId }),
        ...(rendition.draftRevision === null ? {} : { draftRevision: rendition.draftRevision }),
        ...(rendition.approvalId === null ? {} : { approvalId: rendition.approvalId }),
        masked: rendition.masked,
        reused,
      },
    });
  }

  protected override committed(result: RenditionRequestResult): void {
    this.logger.log(
      {
        event: 'document.render_requested',
        renditionId: result.rendition.id,
        documentId: result.rendition.documentId,
        kind: result.rendition.kind,
        reused: result.reused,
        correlationId: requireRequestContext().correlationId,
      },
      'document.render_requested',
    );
  }

  /** Padrão B: depois do commit; falha da fila não desfaz o pedido. */
  private async enqueue(rendition: DocumentRendition): Promise<void> {
    try {
      await this.jobs.enqueue(
        DOCUMENT_RENDER_QUEUE,
        DOCUMENT_RENDER_JOB,
        renderJobPayload(rendition),
        {
          jobId: rendition.id,
          attempts: this.settings.attempts,
          backoffMs: this.settings.backoffMs,
          priority: RENDER_PRIORITY[rendition.kind === 'PREVIEW' ? 'PREVIEW' : 'VERSION'],
        },
      );
    } catch (error) {
      this.logger.warn(
        {
          event: 'document.render_enqueue_deferred',
          renditionId: rendition.id,
          cause: error instanceof Error ? error.name : 'unknown',
          correlationId: requireRequestContext().correlationId,
        },
        'document.render_enqueue_deferred',
      );
    }
  }
}

export interface RequestPreviewInput {
  readonly documentId: string;
}

/** DOC-20 — prévia do rascunho atual (marca d'água "RASCUNHO", 24 h). */
@Injectable()
export class RequestPreviewCommand extends RenditionRequestCommand<RequestPreviewInput> {
  constructor(
    @Inject(DOCUMENT_TRANSACTIONS) transactions: DocumentTransactions,
    @Inject(DOCUMENT_RENDITION_REPOSITORY) renditions: DocumentRenditionRepository,
    @Inject(DOCUMENT_CLOCK) clock: DocumentClock,
    @Inject(RENDITION_SETTINGS) settings: RenditionSettings,
    @Inject(AUDIT_TRAIL) audit: AuditTrailPort,
    @Inject(JOB_QUEUE) jobs: JobQueuePort,
    lifecycle: DocumentLifecycleService,
    access: RenditionAccess,
  ) {
    super(
      'document.render_request',
      transactions,
      renditions,
      clock,
      settings,
      audit,
      jobs,
      lifecycle,
      access,
    );
  }

  protected async handle(
    tx: TenantTx,
    input: RequestPreviewInput,
  ): Promise<RenditionRequestResult> {
    const context = await this.lifecycle.load(tx, input.documentId);
    if (context.type.kind === 'UPLOADED') throw uploadedNotRenderable();
    const { document } = context;
    const rendition = requestPreview({
      id: newId(),
      tenantId: document.tenantId,
      processId: document.processId,
      documentId: document.id,
      draftRevision: document.draftRevision,
      masked: await this.access.maskRequired(context, null),
      requestedById: requesterId(),
      now: this.clock(),
    });
    await this.renditions.insert(tx, rendition);
    await this.record(tx, context, rendition, false);
    return { rendition, reused: false };
  }
}

export interface RequestRenditionInput {
  readonly versionId: string;
  readonly body: RenditionRequest;
}

/** DOC-21 — PDF oficial da versão (`CONTENT`) ou selo de aprovação (`APPROVAL_STAMPED`). */
@Injectable()
export class RequestRenditionCommand extends RenditionRequestCommand<RequestRenditionInput> {
  constructor(
    @Inject(DOCUMENT_TRANSACTIONS) transactions: DocumentTransactions,
    @Inject(DOCUMENT_RENDITION_REPOSITORY) renditions: DocumentRenditionRepository,
    @Inject(DOCUMENT_CLOCK) clock: DocumentClock,
    @Inject(RENDITION_SETTINGS) settings: RenditionSettings,
    @Inject(AUDIT_TRAIL) audit: AuditTrailPort,
    @Inject(JOB_QUEUE) jobs: JobQueuePort,
    lifecycle: DocumentLifecycleService,
    access: RenditionAccess,
    private readonly approvals: DocumentApprovalRegistry,
  ) {
    super(
      'document.render_request',
      transactions,
      renditions,
      clock,
      settings,
      audit,
      jobs,
      lifecycle,
      access,
    );
  }

  protected async handle(
    tx: TenantTx,
    input: RequestRenditionInput,
  ): Promise<RenditionRequestResult> {
    const version = await this.lifecycle.findVersion(tx, input.versionId);
    if (version === null) throw renditionNotFound();
    let context: DocumentContext;
    try {
      context = await this.lifecycle.load(tx, version.documentId);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NOT_FOUND') throw renditionNotFound();
      throw error;
    }
    if (context.type.kind === 'UPLOADED' || version.content === null) {
      throw uploadedNotRenderable();
    }
    const { kind } = input.body;
    const approvalId = kind === 'APPROVAL_STAMPED' ? (input.body.approvalId ?? null) : null;
    if (
      approvalId !== null &&
      !(await this.approvals.coversDocumentVersion(tx, approvalId, version.documentId, version.id))
    ) {
      throw validationError([
        { field: 'approvalId', code: 'REFERENCE_NOT_FOUND', message: RENDITION_MESSAGES.noVersion },
      ]);
    }
    const masked = await this.access.maskRequired(context, version);
    const existing = await this.renditions.findEquivalent(tx, {
      documentVersionId: version.id,
      kind,
      approvalId,
      masked,
    });
    if (existing !== null && isReusable(existing)) {
      await this.record(tx, context, existing, true);
      return { rendition: existing, reused: true };
    }
    const { document } = context;
    const rendition = requestVersionRendition({
      id: newId(),
      tenantId: document.tenantId,
      processId: document.processId,
      documentId: document.id,
      documentVersionId: version.id,
      kind,
      approvalId,
      masked,
      requestedById: requesterId(),
      now: this.clock(),
    });
    await this.renditions.insert(tx, rendition);
    await this.record(tx, context, rendition, false);
    return { rendition, reused: false };
  }
}
