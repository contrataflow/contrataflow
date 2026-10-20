import { AiContentApplied, AiContentReviewed, RISK_AI_MESSAGES } from '@contrataflow/validation';
import type { ApplyAiRisks, RiskDto } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AiSuggestionSourceRegistry } from '#shared/ai/ai-suggestion-source.js';
import type { AiSuggestion } from '#shared/ai/ai-suggestion-source.js';
import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { VersionConflictError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { RISK_CLOCK, RISK_REPOSITORY, RISK_TRANSACTIONS } from './ports.js';
import type { RiskClock, RiskRepository, RiskTransactions } from './ports.js';
import { logContext, RiskCommand, userIdOf } from './risk.commands.js';
import type { Prepared } from './risk.commands.js';
import { countRiskCreated, riskValidationError } from './risk.errors.js';
import {
  RiskChangeRecorder,
  RiskGate,
  RiskPresenter,
  RiskReferences,
  RiskScaleReader,
} from './risk.support.js';
import { selectAiRisks } from '../domain/risk-ai-proposal.js';
import { createRiskTreatment } from '../domain/risk-treatment.js';
import type { RiskTreatment } from '../domain/risk-treatment.js';
import {
  createRiskFromAiProposal,
  diffRisk,
  gradeIssues,
  markRiskAiReviewed,
  nextRiskCode,
} from '../domain/risk.js';
import type { Risk } from '../domain/risk.js';

/*
 * Riscos propostos pela IA (US-119 · RN-AI-40/42 · DEC-079): a CRIAÇÃO é comando do `risk`, por uma
 * pessoa — o `ai` (nível 5) não escreve aqui. RSK-11: numa ÚNICA transação do tenant, POL-02
 * estendida (o `RISK_MAP` travado — 409 se concluído) → proposta pela porta `AiSuggestionSource`
 * (404/403/409) → seleção (V-07) → escala e categorias vigentes → geração `APPLIED` (`markApplied`,
 * condicional, com os ids já reservados) → riscos e tratamentos (códigos sob a trava de numeração
 * do processo) → auditoria
 * `risk.create`/`risk.treatment_create`/`ai.content_apply` → eventos `RiskCreated`,
 * `RiskTreatmentChanged` e `AiContentApplied` → commit. Nenhuma chamada de IA aqui. RSK-12: a
 * revisão humana por risco (`aiReviewedAt`/`aiReviewedById`), com a versão de cada um.
 */

const RISK_MAP = 'RISK_MAP' as const;
const NOT_APPLICABLE_CODES: ReadonlySet<string> = new Set([
  'AI_GENERATION_NOT_APPLICABLE',
  'AI_GENERATION_NOT_OWNED',
  'AI_GENERATION_NOT_FOUND',
]);

/** V-08: 412 `VERSION_CONFLICT` com a versão vigente do risco em `meta.current` (como no DOC-27). */
function reviewConflict(riskId: string, currentVersion: number): ApiError {
  return new ApiError('VERSION_CONFLICT', {
    detail: RISK_AI_MESSAGES.versionConflict,
    extensions: { currentVersion, meta: { current: { [riskId]: currentVersion } } },
  });
}

function notApplicable(): ApiError {
  return new ApiError('AI_GENERATION_NOT_APPLICABLE', { detail: RISK_AI_MESSAGES.notApplicable });
}

export interface ApplyAiRisksInput {
  readonly processId: string;
  readonly body: ApplyAiRisks;
  readonly idempotencyKey: string | null;
}

export interface ApplyAiRisksResult {
  readonly risks: RiskDto[];
  readonly generationId: string;
  readonly treatmentsCount: number;
}

/** `ApplyAiRiskProposalCommand` — RSK-11 (fluxo principal, passos 8–9). */
@Injectable()
export class ApplyAiRisksCommand extends RiskCommand<ApplyAiRisksInput, ApplyAiRisksResult> {
  constructor(
    @Inject(RISK_TRANSACTIONS) transactions: RiskTransactions,
    @Inject(RISK_CLOCK) clock: RiskClock,
    @Inject(RISK_REPOSITORY) private readonly risks: RiskRepository,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly suggestions: AiSuggestionSourceRegistry,
    private readonly gate: RiskGate,
    private readonly scales: RiskScaleReader,
    private readonly references: RiskReferences,
    private readonly presenter: RiskPresenter,
    private readonly recorder: RiskChangeRecorder,
  ) {
    super('ai.risk_proposal_apply', transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    { processId, body, idempotencyKey }: ApplyAiRisksInput,
    { now }: Prepared,
  ): Promise<ApplyAiRisksResult> {
    const write = await this.gate.writable(tx, processId);
    const suggestion = await this.applicable(tx, processId, body.generationId, write.owner);
    const selection = selectAiRisks(suggestion.output.risks ?? [], body.risks);
    if (!selection.ok) throw riskValidationError(selection.issues);

    const snapshot = await this.scales.current(tx);
    const categories = await this.references.activeCategoriesByCode(tx);
    const resolved = selection.selected.map((item, index) => {
      const category = categories.get(item.risk.categoryCode);
      if (category === undefined) {
        throw validationError([
          {
            field: `risks.${String(index)}.proposalKey`,
            code: 'REFERENCE_INACTIVE',
            message: 'A categoria deste risco não está mais disponível.',
          },
        ]);
      }
      // A escala pode ter mudado depois da geração (RN-RISK-03): a proposta não serve mais.
      if (gradeIssues(item.risk, snapshot).length > 0) throw notApplicable();
      return { ...item, category };
    });

    // A geração vai a `APPLIED` ANTES das inserções (ids já reservados): a atualização condicional
    // trava a linha da geração — de duas aplicações simultâneas, a segunda espera e recebe 409 sem
    // ter disputado a numeração nem gravado nada.
    const riskIds = resolved.map(() => newId());
    await this.suggestions.markApplied(tx, {
      generationId: suggestion.generationId,
      targets: { sectionKeys: [], riskIds },
    });

    // RN-RISK-02: os códigos são lidos e gravados sob a trava de numeração do processo.
    await this.risks.lockProcessCodes(tx, processId);
    const used = await this.risks.usedCodes(tx, processId);
    const tenantId = requireRequestContext().tenantId ?? '';
    const userId = userIdOf();
    const created: Risk[] = [];
    let treatmentsCount = 0;
    for (const [index, item] of resolved.entries()) {
      const code = nextRiskCode(used);
      used.push(code);
      const base = createRiskFromAiProposal(
        { ...item.risk, categoryId: item.category.id },
        {
          id: riskIds[index] ?? newId(),
          tenantId,
          processId,
          code,
          snapshot,
          now,
          userId,
          generationId: suggestion.generationId,
        },
      );
      // RN-RISK-14: o risco que nasce com tratamento já está em tratamento.
      const risk: Risk = item.treatments.length > 0 ? { ...base, status: 'IN_TREATMENT' } : base;
      await this.risks.insert(tx, risk);
      await this.recorder.created(tx, risk, diffRisk(null, risk), item.category.code, {
        generationId: suggestion.generationId,
        treatmentsCount: item.treatments.length,
      });
      for (const [position, proposed] of item.treatments.entries()) {
        const treatment: RiskTreatment = createRiskTreatment(
          { type: proposed.type, description: proposed.description },
          {
            id: newId(),
            risk,
            sortOrder: position,
            now,
            userId,
            generationId: suggestion.generationId,
          },
        );
        await this.risks.insertTreatment(tx, treatment);
        await this.recorder.treatmentCreated(
          tx,
          treatment,
          position === 0 ? { from: 'OPEN', to: 'IN_TREATMENT' } : null,
          { generationId: suggestion.generationId },
        );
        treatmentsCount += 1;
      }
      created.push(risk);
    }

    const documentId = write.owner?.id ?? null;
    await this.audit.record(tx, {
      action: 'ai.content_apply',
      entityType: 'AiGeneration',
      entityId: suggestion.generationId,
      processId,
      metadata: {
        generationId: suggestion.generationId,
        documentId,
        targetModule: RISK_MAP,
        riskIds,
        sectionKeys: [],
        treatmentsCount,
        replacedFilledSections: 0,
        model: suggestion.trace.model,
        promptKey: suggestion.trace.promptKey,
        promptVersion: suggestion.trace.promptVersion,
        inputRefs: suggestion.trace.inputRefs.map((ref) => ({ ...ref })),
        contextHash: suggestion.trace.contextHash,
        outputHash: suggestion.trace.outputHash,
        idempotencyKey,
      },
    });
    await this.outbox.record(
      tx,
      AiContentApplied.of({
        aggregateId: documentId ?? processId,
        processId,
        payload: {
          generationId: suggestion.generationId,
          documentId,
          documentTypeCode: RISK_MAP,
          targetModule: RISK_MAP,
          sectionKeys: [],
          riskIds,
          replacedFilledSections: 0,
        },
      }),
    );
    return {
      risks: await this.presenter.present(tx, created),
      generationId: suggestion.generationId,
      treatmentsCount,
    };
  }

  /** V-06: proposta do solicitante, `SUCCEEDED`, não vencida, deste processo e sem riscos aplicados. */
  private async applicable(
    tx: TenantTx,
    processId: string,
    generationId: string,
    owner: { readonly id: string } | null,
  ): Promise<AiSuggestion> {
    try {
      const suggestion = await this.suggestions.loadForApply(tx, {
        generationId,
        targetModule: RISK_MAP,
        documentId: owner?.id ?? null,
      });
      const risksApplied = (suggestion.appliedTargets?.riskIds.length ?? 0) > 0;
      if (suggestion.processId !== processId || risksApplied || !suggestion.output.risks?.length) {
        throw notApplicable();
      }
      return suggestion;
    } catch (error) {
      if (error instanceof ApiError && NOT_APPLICABLE_CODES.has(error.code)) {
        this.logger.warn(
          {
            event: 'ai.risk_proposal_not_applicable',
            generationId,
            reason: error.code,
            ...logContext(),
          },
          'ai.risk_proposal_not_applicable',
        );
      }
      throw error;
    }
  }

  protected override committed(result: ApplyAiRisksResult, durationMs: number): void {
    for (const risk of result.risks) countRiskCreated(risk.level);
    this.logger.log(
      {
        event: 'ai.risk_proposal_applied',
        generationId: result.generationId,
        risksCount: result.risks.length,
        treatmentsCount: result.treatmentsCount,
        durationMs,
        ...logContext(),
      },
      'ai.risk_proposal_applied',
    );
  }
}

export interface ReviewAiRisksInput {
  readonly processId: string;
  readonly riskIds: readonly string[];
  readonly expectedVersions: Readonly<Record<string, number>>;
}

export interface ReviewAiRisksResult {
  readonly risks: RiskDto[];
  readonly reviewedRiskIds: string[];
}

/** `ReviewAiRisksCommand` — RSK-12 (fluxo principal, passo 10 · RN-AI-42). */
@Injectable()
export class ReviewAiRisksCommand extends RiskCommand<ReviewAiRisksInput, ReviewAiRisksResult> {
  constructor(
    @Inject(RISK_TRANSACTIONS) transactions: RiskTransactions,
    @Inject(RISK_CLOCK) clock: RiskClock,
    @Inject(RISK_REPOSITORY) private readonly risks: RiskRepository,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly gate: RiskGate,
    private readonly presenter: RiskPresenter,
  ) {
    super('ai.content_review', transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    { processId, riskIds, expectedVersions }: ReviewAiRisksInput,
    { now }: Prepared,
  ): Promise<ReviewAiRisksResult> {
    const write = await this.gate.writable(tx, processId);
    const userId = userIdOf();
    if (userId === null) throw new ApiError('UNAUTHENTICATED');
    const ids = [...new Set(riskIds)];
    const current: Risk[] = [];
    for (const [index, id] of ids.entries()) {
      const risk = await this.risks.findById(tx, id);
      if (risk?.processId !== processId) {
        throw validationError([
          {
            field: `riskIds.${String(index)}`,
            code: 'REFERENCE_NOT_FOUND',
            message: 'Risco não encontrado neste processo.',
          },
        ]);
      }
      const expected = expectedVersions[id];
      if (risk.version !== expected) throw reviewConflict(risk.id, risk.version);
      current.push(risk);
    }

    const saved: Risk[] = [];
    const reviewed: Risk[] = [];
    for (const risk of current) {
      const next = markRiskAiReviewed(risk, userId, now);
      if (next === null) {
        saved.push(risk);
        continue;
      }
      try {
        await this.risks.update(tx, next, risk.version);
      } catch (error) {
        if (error instanceof VersionConflictError) {
          const latest = await this.risks.findById(tx, risk.id);
          throw reviewConflict(risk.id, latest?.version ?? risk.version);
        }
        throw error;
      }
      const after: Risk = { ...next, version: risk.version + 1 };
      saved.push(after);
      reviewed.push(after);
    }

    if (reviewed.length > 0) {
      const reviewedIds = reviewed.map((risk) => risk.id);
      const generationIds = [
        ...new Set(reviewed.flatMap((risk) => (risk.aiGenerationId ? [risk.aiGenerationId] : []))),
      ];
      const documentId = write.owner?.id ?? null;
      await this.audit.record(tx, {
        action: 'ai.content_review',
        entityType: 'Process',
        entityId: processId,
        processId,
        changes: reviewed.map((risk) => ({
          path: `risks.${risk.id}.aiReviewedAt`,
          old: null,
          new: now.toISOString(),
        })),
        metadata: { documentId, targetModule: RISK_MAP, riskIds: reviewedIds, generationIds },
      });
      await this.outbox.record(
        tx,
        AiContentReviewed.of({
          aggregateId: documentId ?? processId,
          processId,
          payload: {
            documentId,
            documentTypeCode: RISK_MAP,
            targetModule: RISK_MAP,
            sectionKeys: [],
            riskIds: reviewedIds,
            generationIds,
          },
        }),
      );
    }
    return {
      risks: await this.presenter.present(tx, saved),
      reviewedRiskIds: reviewed.map((risk) => risk.id),
    };
  }

  protected override committed(result: ReviewAiRisksResult, durationMs: number): void {
    if (result.reviewedRiskIds.length === 0) return;
    this.logger.log(
      {
        event: 'ai.content_reviewed',
        targetModule: RISK_MAP,
        risksCount: result.reviewedRiskIds.length,
        durationMs,
        ...logContext(),
      },
      'ai.content_reviewed',
    );
  }
}
