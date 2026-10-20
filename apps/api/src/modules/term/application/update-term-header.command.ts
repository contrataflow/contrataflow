import { createHash } from 'node:crypto';

import { TERM_CONDITION_MESSAGES, TERM_MESSAGES } from '@contrataflow/validation';
import type { TermDto, TermMeta, TermPatch } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditChange, AuditTrailPort } from '#shared/audit/audit-trail.js';
import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { VersionConflictError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';
import {
  isCompletedPriceResearch,
  PriceResearchSummaryRegistry,
} from '#shared/price-research/price-research-summary.js';

import { TERM_CLOCK, TERM_REPOSITORY, TERM_TRANSACTIONS } from './ports.js';
import type { TermClock, TermRepository, TermTransactions } from './ports.js';
import { toTermDto, toTermMeta } from './term.presenter.js';
import { termNotFound } from './term.queries.js';
import { CatalogFacade } from '../../catalog/application/catalog.facade.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import type { EditableTypedDocument } from '../../document/application/document.facade.js';
import {
  applyTermHeader,
  estimatedFromResearch,
  estimatedValueIntent,
  isConditionField,
  manualEstimated,
  mergeTermConditions,
} from '../domain/term-of-reference.js';
import type {
  EstimatedValue,
  EstimatedValueIntent,
  TermConditions,
  TermHeaderChange,
  TermOfReference,
} from '../domain/term-of-reference.js';

/*
 * TRM-04 — Atualizar o TR, painéis "Dados do TR" (US-036 · RN-TR-08/10/14) e "Condições
 * contratuais" (US-038 · RN-TR-28..33): objeto, valor estimado e condições tipadas com
 * `If-Match: "<version>"`. Numa transação: TR do
 * tenant (404) → documento travado, visível, `TERM_UPDATE` + POL-02 — custódia OU participação
 * `COLLABORATOR`/`CONSULTANT` (403), processo editável (409), tipo na etapa (422) — e editável (409
 * `DOCUMENT_NOT_EDITABLE`) → `If-Match` (412 `VERSION_CONFLICT` com o TR atual) → POL-09 (quem não
 * vê o valor também não o altera — 403) → origem/valor (422) e pesquisa do processo (V-12) →
 * `version + 1` condicionada → `document.draft_update` (objeto como hash + tamanho; valor mascarado
 * em processo sigiloso). US-038: as faixas vêm do schema; o par prazo × tipo de contagem é conferido
 * sobre o estado resultante (422 `CONDITIONAL_REQUIRED`) e o critério de julgamento novo tem de ser
 * item ativo do catálogo `JUDGMENT_CRITERION` do tenant (422 `REFERENCE_NOT_FOUND`/
 * `REFERENCE_INACTIVE` — outro tenant é indistinguível do inexistente); o local de entrega vai à
 * auditoria como hash + tamanho. Sem evento de domínio nem notificação. Logs sem valores.
 */

/** Valor mascarado da estimativa sigilosa na auditoria (POL-09). */
const MASKED = '[MASKED]';

const VALUE_FIELDS = new Set(['estimatedTotalValue', 'priceResearchId', 'estimatedValueSource']);

/** Campos de texto livre: na auditoria só hash + tamanho (story US-036/US-038 · "Logs"). */
const FINGERPRINTED = new Set(['objectDefinition', 'deliveryLocation']);

function fingerprint(text: unknown): unknown {
  if (typeof text !== 'string') return text;
  return {
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    length: Array.from(text).length,
  };
}

/**
 * POL-02 de edição pelo `document` (TERM_UPDATE + custódia OU participação, processo editável, tipo
 * na etapa, TR em `DRAFT`/`RETURNED`), com as mensagens do TR; `null` = o 404 do TR. Usada também
 * pela importação do ETP (US-037).
 */
export async function openEditableTerm(
  documents: DocumentFacade,
  tx: TenantTx,
  term: TermOfReference,
  messages: { readonly permissionDenied: string; readonly notEditable: string } = TERM_MESSAGES,
): Promise<EditableTypedDocument> {
  let view: EditableTypedDocument | null;
  try {
    view = await documents.editableTypedDocumentIn(tx, term.documentId, {
      notCustodianDetail: messages.permissionDenied,
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === 'DOCUMENT_NOT_EDITABLE') {
      throw new ApiError('DOCUMENT_NOT_EDITABLE', {
        detail: messages.notEditable,
        extensions: error.extensions,
      });
    }
    throw error;
  }
  if (view === null) throw termNotFound();
  return view;
}

export interface UpdateTermHeaderInput {
  readonly termId: string;
  readonly expectedVersion: number;
  readonly patch: TermPatch;
}

export interface UpdatedTerm {
  readonly dto: TermDto;
  readonly meta: TermMeta;
  readonly changedFields: readonly string[];
}

@Injectable()
export class UpdateTermHeaderCommand extends TransactionalCommandHandler<
  UpdateTermHeaderInput,
  undefined,
  UpdatedTerm
> {
  constructor(
    @Inject(TERM_TRANSACTIONS) transactions: TermTransactions,
    @Inject(TERM_REPOSITORY) private readonly terms: TermRepository,
    @Inject(TERM_CLOCK) private readonly clock: TermClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    private readonly documents: DocumentFacade,
    private readonly researches: PriceResearchSummaryRegistry,
    private readonly catalogs: CatalogFacade,
  ) {
    super('term.header_save', transactions);
  }

  protected prepare(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  protected async handle(tx: TenantTx, input: UpdateTermHeaderInput): Promise<UpdatedTerm> {
    const term = await this.terms.findById(tx, input.termId);
    if (term === null) throw termNotFound();
    const view = await openEditableTerm(this.documents, tx, term);
    const masked = view.isBudgetConfidential && !view.canViewConfidentialBudget;
    if (term.version !== input.expectedVersion) throw this.conflict(term, view, masked);
    const { patch } = input;
    const touchesValue = Object.keys(patch).some((field) => VALUE_FIELDS.has(field));
    if (touchesValue && masked) {
      throw new ApiError('PERMISSION_DENIED', {
        detail: TERM_MESSAGES.permissionDenied,
        auditReasonCode: 'POL-09',
        auditDenial: true,
      });
    }
    const intent = estimatedValueIntent(term, patch);
    if (!intent.ok) throw validationError([intent.error]);
    const estimated = await this.resolve(tx, term, intent.intent);
    const conditions = await this.conditionsOf(tx, term, patch);

    const actorId = requireRequestContext().actor.userId ?? '';
    const { term: next, changes } = applyTermHeader(
      term,
      {
        ...(patch.objectDefinition === undefined
          ? {}
          : { objectDefinition: patch.objectDefinition }),
        ...(estimated === undefined ? {} : { estimated }),
        ...(conditions === undefined ? {} : { conditions }),
      },
      { actorId, now: this.clock() },
    );
    if (changes.length === 0) {
      return {
        dto: toTermDto(term, view.document, view.template, { masked }),
        meta: toTermMeta(view.allowedActions),
        changedFields: [],
      };
    }
    const saved = await this.persist(tx, next, input.expectedVersion, view, masked);
    await this.record(tx, saved, changes, view);
    return {
      dto: toTermDto(saved, view.document, view.template, { masked }),
      meta: toTermMeta(view.allowedActions),
      changedFields: changes.map((change) => change.field),
    };
  }

  protected override committed(result: UpdatedTerm, durationMs: number): void {
    if (result.changedFields.length === 0) return;
    const conditionFields = result.changedFields.filter(isConditionField);
    if (conditionFields.length > 0) {
      this.logger.log(
        {
          event: 'term.conditions_updated',
          termId: result.dto.id,
          fieldsChanged: conditionFields,
          version: result.dto.version,
          durationMs,
        },
        'term.conditions_updated',
      );
    }
    if (conditionFields.length === result.changedFields.length) return;
    this.logger.log(
      {
        event: 'term.header_saved',
        termId: result.dto.id,
        changedFields: result.changedFields,
        version: result.dto.version,
        durationMs,
      },
      'term.header_saved',
    );
  }

  /**
   * As condições contratuais resultantes (US-038), ou `undefined` se o corpo não traz nenhuma:
   * RN-TR-29 sobre o estado final e o critério de julgamento novo ativo no tenant (RN-TR-32 · V-09).
   */
  private async conditionsOf(
    tx: TenantTx,
    term: TermOfReference,
    patch: TermPatch,
  ): Promise<TermConditions | undefined> {
    if (!Object.keys(patch).some(isConditionField)) return undefined;
    const merged = mergeTermConditions(term, patch);
    if (!merged.ok) throw validationError([merged.error]);
    const criterionId = merged.conditions.selectionCriterionId;
    if (criterionId !== null && criterionId !== term.selectionCriterionId) {
      const criterion = await this.catalogs.find(tx, criterionId);
      if (criterion?.catalogType !== 'JUDGMENT_CRITERION' || !criterion.isActive) {
        throw validationError([
          {
            field: 'selectionCriterionId',
            code:
              criterion?.catalogType === 'JUDGMENT_CRITERION'
                ? 'REFERENCE_INACTIVE'
                : 'REFERENCE_NOT_FOUND',
            message: TERM_CONDITION_MESSAGES.criterionInvalid,
          },
        ]);
      }
    }
    return merged.conditions;
  }

  /**
   * O valor estimado pedido: a pesquisa (a indicada, a vinculada ou a concluída do processo) tem de
   * ser do processo (V-12 — `REFERENCE_NOT_FOUND`) e estar concluída (`REFERENCE_INACTIVE`).
   */
  private async resolve(
    tx: TenantTx,
    term: TermOfReference,
    intent: EstimatedValueIntent,
  ): Promise<EstimatedValue | undefined> {
    if (intent.kind === 'NONE') return undefined;
    if (intent.kind === 'MANUAL') return manualEstimated(intent.value);
    const research =
      intent.priceResearchId === null
        ? await this.researches.completedOf(tx, term.processId)
        : await this.researches.findInProcess(tx, term.processId, intent.priceResearchId);
    if (research === null) {
      throw validationError([
        {
          field: 'priceResearchId',
          code: 'REFERENCE_NOT_FOUND',
          message: TERM_MESSAGES.priceResearchInvalid,
        },
      ]);
    }
    if (!isCompletedPriceResearch(research) || research.totalEstimatedValue === null) {
      throw validationError([
        {
          field: 'priceResearchId',
          code: 'REFERENCE_INACTIVE',
          message: TERM_MESSAGES.priceResearchNotCompleted,
        },
      ]);
    }
    return estimatedFromResearch({
      id: research.id,
      totalEstimatedValue: research.totalEstimatedValue,
    });
  }

  /** Grava condicionado à versão; corrida perdida → 412 com o TR vencedor. */
  private async persist(
    tx: TenantTx,
    next: TermOfReference,
    expectedVersion: number,
    view: EditableTypedDocument,
    masked: boolean,
  ): Promise<TermOfReference> {
    try {
      await this.terms.updateHeader(tx, next, expectedVersion);
    } catch (error) {
      if (!(error instanceof VersionConflictError)) throw error;
      const latest = await this.terms.findById(tx, next.id);
      if (latest === null) throw termNotFound();
      throw this.conflict(latest, view, masked);
    }
    return { ...next, version: expectedVersion + 1 };
  }

  /** `document.draft_update` imediato do painel "Dados do TR" (RN-TR-08 · Auditoria da US-036). */
  private async record(
    tx: TenantTx,
    saved: TermOfReference,
    changes: readonly TermHeaderChange[],
    view: EditableTypedDocument,
  ): Promise<void> {
    const auditChanges: AuditChange[] = changes.map((change) => {
      if (FINGERPRINTED.has(change.field)) {
        return { path: change.field, old: fingerprint(change.old), new: fingerprint(change.new) };
      }
      if (change.field === 'estimatedTotalValue' && view.isBudgetConfidential) {
        return { path: change.field, old: MASKED, new: MASKED };
      }
      return { path: change.field, old: change.old, new: change.new };
    });
    await this.audit.record(tx, {
      action: 'document.draft_update',
      entityType: 'Document',
      entityId: saved.documentId,
      processId: saved.processId,
      changes: auditChanges,
      metadata: {
        documentCode: view.document.code,
        target: 'HEADER',
        fields: changes.map((change) => change.field),
        version: saved.version,
      },
    });
  }

  /** 412 `VERSION_CONFLICT` com o TR atual (o painel recarrega e reaplica a edição). */
  private conflict(
    current: TermOfReference,
    view: EditableTypedDocument,
    masked: boolean,
  ): ApiError {
    return new ApiError('VERSION_CONFLICT', {
      detail: TERM_MESSAGES.versionConflict,
      extensions: {
        currentVersion: current.version,
        meta: { current: toTermDto(current, view.document, view.template, { masked }) },
      },
    });
  }
}
