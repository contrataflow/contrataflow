import { AI_TARGET_MODULES } from '@contrataflow/types';
import type { AiTargetModule } from '@contrataflow/types';
import { AiContentApplied, DOCUMENT_MESSAGES } from '@contrataflow/validation';
import type { DocumentAction } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AiSuggestionSourceRegistry } from '#shared/ai/ai-suggestion-source.js';
import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { DocumentLifecycleService } from './document-lifecycle.service.js';
import { recordDocumentVersion } from './document.commands.js';
import { DOCUMENT_CLOCK, DOCUMENT_TRANSACTIONS } from './ports.js';
import type { DocumentClock, DocumentTransactions } from './ports.js';
import { AiApplyRejectedError, applyAiSections } from '../domain/ai-content-apply.js';
import type { DocumentType } from '../domain/document-type.js';
import { recordManualVersion } from '../domain/document.js';
import type { Document } from '../domain/document.js';

/*
 * `ApplyAiContentCommand` — DOC-26 (US-117 · RN-AI-27..29 · DEC-079): a aplicação seletiva, por
 * uma pessoa, da proposta de IA nas seções do documento. Numa ÚNICA transação do tenant: documento
 * travado → permissão de EDIÇÃO do tipo + POL-02 → proposta pela porta `AiSuggestionSource`
 * (404 `AI_GENERATION_NOT_FOUND`, 403 `AI_GENERATION_NOT_OWNED`, 409 `AI_GENERATION_NOT_APPLICABLE`)
 * → `If-Match` (412) → `applyAiSections` (409 `DOCUMENT_NOT_EDITABLE`, 422 V-10) → versão `SYSTEM`
 * "Antes de aplicar…" quando o rascunho completo substitui seção preenchida → gravação → geração
 * `APPLIED` (`markApplied`, mesma transação) → auditoria `ai.content_apply` → `AiContentApplied`
 * (timeline `AI_CONTENT_APPLIED` síncrona) → commit. Sem notificação. Nunca registra o texto.
 */

export interface ApplyAiContentInput {
  readonly documentId: string;
  readonly generationId: string;
  readonly sectionKeys: readonly string[];
  readonly confirmReplaceFilled: boolean;
  readonly expectedVersion: number;
  readonly idempotencyKey: string | null;
}

export interface ApplyAiContentResult {
  readonly document: Document;
  readonly type: DocumentType;
  readonly allowedActions: DocumentAction[];
  readonly appliedSectionKeys: readonly string[];
  readonly replacedFilledSections: number;
  readonly versionCreated: { readonly id: string; readonly versionNumber: number } | null;
  readonly generationId: string;
  readonly targetModule: AiTargetModule | null;
}

const AI_TARGETS: ReadonlySet<string> = new Set(AI_TARGET_MODULES);

function targetModuleOf(type: DocumentType): AiTargetModule | null {
  const module = type.systemModule;
  return module !== null && AI_TARGETS.has(module) ? (module as AiTargetModule) : null;
}

@Injectable()
export class ApplyAiContentCommand extends TransactionalCommandHandler<
  ApplyAiContentInput,
  undefined,
  ApplyAiContentResult
> {
  constructor(
    @Inject(DOCUMENT_TRANSACTIONS) transactions: DocumentTransactions,
    private readonly lifecycle: DocumentLifecycleService,
    private readonly suggestions: AiSuggestionSourceRegistry,
    @Inject(DOCUMENT_CLOCK) private readonly clock: DocumentClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
  ) {
    super('ai.content_apply', transactions);
  }

  protected prepare(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  protected async handle(tx: TenantTx, input: ApplyAiContentInput): Promise<ApplyAiContentResult> {
    // Linha travada: aplicação × autosave/transição — a `version` lida é a atual até o commit.
    await this.lifecycle.lockForVersioning(tx, input.documentId);
    const context = await this.lifecycle.load(tx, input.documentId);
    const actor = await this.lifecycle.actorOf(context);
    await this.lifecycle.authorizePol02(context, actor, 'edit');
    const actorId = actor.userId;
    if (actorId === '') throw new ApiError('UNAUTHENTICATED');

    const { document, type } = context;
    const targetModule = targetModuleOf(type);
    if (targetModule === null) throw this.notApplicable();
    const suggestion = await this.suggestions.loadForApply(tx, {
      generationId: input.generationId,
      targetModule,
      documentId: document.id,
    });
    if (suggestion.documentId !== document.id) throw this.notApplicable();
    this.lifecycle.assertVersion(context, input.expectedVersion);

    const now = this.clock();
    const maxChars = new Map(
      (context.template?.sections ?? []).map((section) => [section.key, section.maxChars]),
    );
    const outcome = this.lifecycle.transition(() => {
      try {
        return applyAiSections(document, {
          generationId: suggestion.generationId,
          proposal: suggestion.output.sections,
          sectionKeys: input.sectionKeys,
          confirmReplaceFilled: input.confirmReplaceFilled,
          maxCharsOf: (key) => maxChars.get(key),
          actorId,
          now,
        });
      } catch (error) {
        if (error instanceof AiApplyRejectedError) throw this.rejected(error);
        throw error;
      }
    });

    // RN-AI-28: o rascunho completo que substitui texto preenchido guarda antes uma versão SYSTEM.
    const needsVersion = suggestion.kind === 'DRAFT' && outcome.replacedSectionKeys.length > 0;
    let versionCreated: ApplyAiContentResult['versionCreated'] = null;
    let next = outcome.document;
    let before: Document | null = null;
    if (needsVersion) {
      const versionId = newId();
      const versionNumber = await this.lifecycle.nextVersionNumber(tx, document.id);
      before = recordManualVersion(document, { actorId, now, versionId, versionNumber });
      next = {
        ...next,
        currentVersionId: before.currentVersionId,
        currentVersionNumber: before.currentVersionNumber,
      };
      versionCreated = { id: versionId, versionNumber };
    }
    // Gravação condicionada ANTES da versão (FKs `DEFERRABLE`), como nas transições.
    const saved = await this.lifecycle.save(tx, next, document.version);
    if (before !== null && versionCreated !== null) {
      // O snapshot guarda o texto ANTERIOR à aplicação ("Antes de aplicar conteúdo gerado por IA").
      const version = await this.lifecycle.createVersion(tx, context, {
        document: before,
        versionId: versionCreated.id,
        versionNumber: versionCreated.versionNumber,
        reason: 'SYSTEM',
        actorId,
        now,
        changeSummary: DOCUMENT_MESSAGES.aiApplyVersionSummary,
      });
      await recordDocumentVersion(this.audit, this.outbox, tx, context, version);
    }

    await this.suggestions.markApplied(tx, {
      generationId: suggestion.generationId,
      targets: { sectionKeys: [...outcome.appliedSectionKeys], riskIds: [] },
    });

    const appliedAt = now.toISOString();
    await this.audit.record(tx, {
      action: 'ai.content_apply',
      entityType: 'Document',
      entityId: saved.id,
      processId: saved.processId,
      changes: outcome.appliedSectionKeys.map((key) => ({
        path: `sections.${key}.ai.appliedAt`,
        old: document.draftContent.sections[key]?.ai?.appliedAt ?? null,
        new: appliedAt,
      })),
      metadata: {
        documentId: saved.id,
        documentCode: saved.code,
        targetModule,
        generationId: suggestion.generationId,
        sectionKeys: [...outcome.appliedSectionKeys],
        model: suggestion.trace.model,
        promptKey: suggestion.trace.promptKey,
        promptVersion: suggestion.trace.promptVersion,
        inputRefs: suggestion.trace.inputRefs.map((ref) => ({ ...ref })),
        contextHash: suggestion.trace.contextHash,
        outputHash: suggestion.trace.outputHash,
        replacedFilledSections: outcome.replacedSectionKeys.length,
        versionCreated,
        idempotencyKey: input.idempotencyKey,
      },
    });
    await this.outbox.record(
      tx,
      AiContentApplied.of({
        aggregateId: saved.id,
        processId: saved.processId,
        payload: {
          generationId: suggestion.generationId,
          documentId: saved.id,
          documentTypeCode: type.code,
          targetModule,
          sectionKeys: [...outcome.appliedSectionKeys],
          riskIds: [],
          replacedFilledSections: outcome.replacedSectionKeys.length,
        },
      }),
    );
    return {
      document: saved,
      type,
      allowedActions: this.lifecycle.allowedActions({ ...context, document: saved }, actor),
      appliedSectionKeys: outcome.appliedSectionKeys,
      replacedFilledSections: outcome.replacedSectionKeys.length,
      versionCreated,
      generationId: suggestion.generationId,
      targetModule,
    };
  }

  protected override committed(result: ApplyAiContentResult, durationMs: number): void {
    this.logger.log(
      {
        event: 'ai.content_applied',
        generationId: result.generationId,
        documentId: result.document.id,
        targetModule: result.targetModule,
        sectionsCount: result.appliedSectionKeys.length,
        replacedFilledSections: result.replacedFilledSections,
        versionCreated: result.versionCreated !== null,
        durationMs,
        correlationId: requireRequestContext().correlationId,
      },
      'ai.content_applied',
    );
  }

  private notApplicable(): ApiError {
    return new ApiError('AI_GENERATION_NOT_APPLICABLE', {
      detail: DOCUMENT_MESSAGES.aiApplyNotApplicable,
    });
  }

  /** V-10 (422) e conteúdo da proposta inválido (409 — falha fechada, gere novamente). */
  private rejected(error: AiApplyRejectedError): ApiError {
    switch (error.reason) {
      case 'SECTION_NOT_IN_PROPOSAL':
        return validationError([
          {
            field: 'sectionKeys',
            code: 'NOT_ALLOWED',
            message: DOCUMENT_MESSAGES.aiApplySectionNotInProposal,
          },
        ]);
      case 'CONFIRM_REPLACE_REQUIRED':
        return validationError([
          {
            field: 'confirmReplaceFilled',
            code: 'CONDITIONAL_REQUIRED',
            message: DOCUMENT_MESSAGES.aiApplyConfirmReplace,
          },
        ]);
      case 'CONTENT_INVALID':
        this.logger.error(
          {
            event: 'ai.apply_failed',
            errorCode: 'CONTENT_INVALID',
            sectionsCount: error.sectionKeys.length,
            correlationId: requireRequestContext().correlationId,
          },
          'ai.apply_failed',
        );
        return this.notApplicable();
    }
  }
}
