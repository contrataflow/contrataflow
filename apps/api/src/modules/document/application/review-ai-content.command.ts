import { AI_TARGET_MODULES } from '@contrataflow/types';
import type { AiTargetModule } from '@contrataflow/types';
import { AiContentReviewed, DOCUMENT_MESSAGES } from '@contrataflow/validation';
import type { DocumentAction } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { DocumentLifecycleService } from './document-lifecycle.service.js';
import type { DocumentContext } from './document-lifecycle.service.js';
import { DOCUMENT_CLOCK, DOCUMENT_TRANSACTIONS } from './ports.js';
import type { DocumentClock, DocumentTransactions } from './ports.js';
import type { DocumentType } from '../domain/document-type.js';
import type { Document } from '../domain/document.js';
import { AiReviewConflictError, reviewAiSections } from '../domain/section-ai-provenance.js';

/*
 * `ReviewAiContentCommand` — DOC-27 (US-122 · RN-AI-56): a revisão humana do conteúdo gerado por
 * IA, por seção ou em lote ("Revisar todas"). Numa transação do tenant: documento travado →
 * permissão de EDIÇÃO do tipo + POL-02 (`AI_GENERATE` não é exigida — FA-05) → chaves do documento
 * (V-01) → revisões esperadas das seções pendentes (V-04 → 412) → `reviewedAt/By`, `revision + 1`
 * e `draftRevision + 1` → auditoria `ai.content_review` → `AiContentReviewed` (timeline
 * `AI_CONTENT_REVIEWED` síncrona) → commit. Nada pendente = 200 sem gravar nem publicar (FA-07).
 * Nunca registra texto de seção — só chaves, ids de geração e contagens.
 */

export interface ReviewAiContentInput {
  readonly documentId: string;
  readonly sectionKeys: readonly string[];
  readonly expectedRevisions: Readonly<Record<string, number>>;
  readonly confirmAll: boolean;
}

export interface ReviewAiContentResult {
  readonly document: Document;
  readonly type: DocumentType;
  readonly allowedActions: DocumentAction[];
  readonly reviewedSectionKeys: readonly string[];
  readonly generationIds: readonly string[];
  readonly targetModule: AiTargetModule | null;
}

const AI_TARGETS: ReadonlySet<string> = new Set(AI_TARGET_MODULES);

function targetModuleOf(type: DocumentType): AiTargetModule | null {
  const module = type.systemModule;
  return module !== null && AI_TARGETS.has(module) ? (module as AiTargetModule) : null;
}

@Injectable()
export class ReviewAiContentCommand extends TransactionalCommandHandler<
  ReviewAiContentInput,
  undefined,
  ReviewAiContentResult
> {
  constructor(
    @Inject(DOCUMENT_TRANSACTIONS) transactions: DocumentTransactions,
    private readonly lifecycle: DocumentLifecycleService,
    @Inject(DOCUMENT_CLOCK) private readonly clock: DocumentClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
  ) {
    super('ai.content_review', transactions);
  }

  protected prepare(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  protected async handle(
    tx: TenantTx,
    input: ReviewAiContentInput,
  ): Promise<ReviewAiContentResult> {
    // Linha travada: duas revisões simultâneas — a segunda lê a seção já revisada e a ignora.
    await this.lifecycle.lockForVersioning(tx, input.documentId);
    const context = await this.lifecycle.load(tx, input.documentId);
    const actor = await this.lifecycle.actorOf(context);
    await this.lifecycle.authorizePol02(context, actor, 'edit');
    const actorId = actor.userId;
    if (actorId === '') throw new ApiError('UNAUTHENTICATED');
    this.assertKnownKeys(context, input.sectionKeys);

    const { document, type } = context;
    const outcome = this.lifecycle.transition(() => {
      try {
        return reviewAiSections(document, {
          sectionKeys: input.sectionKeys,
          expectedRevisions: input.expectedRevisions,
          actorId,
          now: this.clock(),
        });
      } catch (error) {
        if (error instanceof AiReviewConflictError) throw this.conflict(document.id, error);
        throw error;
      }
    });
    const targetModule = targetModuleOf(type);
    const result = (saved: Document): ReviewAiContentResult => ({
      document: saved,
      type,
      allowedActions: this.lifecycle.allowedActions({ ...context, document: saved }, actor),
      reviewedSectionKeys: outcome.reviewedSectionKeys,
      generationIds: outcome.generationIds,
      targetModule,
    });
    if (outcome.reviewedSectionKeys.length === 0) return result(document);

    // Com a linha travada a `version` lida é a atual: a gravação condicionada não perde corrida.
    const saved = await this.lifecycle.save(tx, outcome.document, document.version);
    const reviewedAt = outcome.document.updatedAt.toISOString();
    await this.audit.record(tx, {
      action: 'ai.content_review',
      entityType: 'Document',
      entityId: saved.id,
      processId: saved.processId,
      changes: outcome.reviewedSectionKeys.map((key) => ({
        path: `sections.${key}.ai.reviewedAt`,
        old: null,
        new: reviewedAt,
      })),
      metadata: {
        documentId: saved.id,
        documentCode: saved.code,
        targetModule,
        sectionKeys: [...outcome.reviewedSectionKeys],
        generationIds: [...outcome.generationIds],
        confirmAll: input.confirmAll,
      },
    });
    await this.outbox.record(
      tx,
      AiContentReviewed.of({
        aggregateId: saved.id,
        processId: saved.processId,
        payload: {
          documentId: saved.id,
          documentTypeCode: type.code,
          targetModule,
          sectionKeys: [...outcome.reviewedSectionKeys],
          riskIds: [],
          generationIds: [...outcome.generationIds],
        },
      }),
    );
    return result(saved);
  }

  protected override committed(result: ReviewAiContentResult, durationMs: number): void {
    if (result.reviewedSectionKeys.length === 0) return;
    this.logger.log(
      {
        event: 'ai.content_reviewed',
        documentId: result.document.id,
        targetModule: result.targetModule,
        sectionsCount: result.reviewedSectionKeys.length,
        generationIds: result.generationIds,
        durationMs,
        correlationId: requireRequestContext().correlationId,
      },
      'ai.content_reviewed',
    );
  }

  /** V-01: toda chave existe no documento (template da versão ou rascunho) — senão `NOT_ALLOWED`. */
  private assertKnownKeys(context: DocumentContext, keys: readonly string[]): void {
    const known = new Set([
      ...(context.template?.sections ?? []).map((section) => section.key),
      ...Object.keys(context.document.draftContent.sections),
    ]);
    if (keys.every((key) => known.has(key))) return;
    throw validationError([
      {
        field: 'sectionKeys',
        code: 'NOT_ALLOWED',
        message: DOCUMENT_MESSAGES.aiReviewSectionsRequired,
      },
    ]);
  }

  /** V-04: 412 com as revisões atuais das seções divergentes (`meta.current`). */
  private conflict(documentId: string, error: AiReviewConflictError): ApiError {
    this.logger.warn(
      {
        event: 'ai.review_revision_conflict',
        documentId,
        sectionsCount: Object.keys(error.current).length,
        correlationId: requireRequestContext().correlationId,
      },
      'ai.review_revision_conflict',
    );
    return new ApiError('VERSION_CONFLICT', {
      detail: DOCUMENT_MESSAGES.aiReviewSectionChanged,
      extensions: { meta: { current: error.current } },
    });
  }
}
