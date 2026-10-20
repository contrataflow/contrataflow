import { PRICE_COMPLETION_MESSAGES, PRICE_RESEARCH_MESSAGES } from '@contrataflow/validation';
import type {
  CompletedPriceResearchDto,
  PriceResearchMeta,
  Violation,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Histogram } from '@opentelemetry/api';

import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { PRICE_RESEARCH_REPOSITORY, PRICE_RESEARCH_TRANSACTIONS } from './ports.js';
import type { PriceResearchRepository, PriceResearchTransactions } from './ports.js';
import { PriceResearchDocumentValidator } from './price-research-document.validator.js';
import {
  COMPLETE_PERMISSION,
  PriceResearchGate,
  PriceResearchPresenter,
} from './price-research.support.js';
import type { WritableOptions } from './price-research.support.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import type { DocumentTransitionResult } from '../../document/application/document.facade.js';
import type { PriceResearch } from '../domain/price-research.js';

/*
 * `CompletePriceResearchCommand` — PRS-23 (US-032 · RN-PRICE-58..63). Concluir é finalizar o
 * `Document` da pesquisa (DEC-018), numa ÚNICA transação do tenant (READ COMMITTED):
 *
 * 1. guarda da pesquisa com `PRICE_RESEARCH_COMPLETE` (POL-02 estendida — documento dono travado,
 *    `DRAFT`/`RETURNED`, custódia/participação, etapa e processo — + POL-09 + `FOR UPDATE` da linha);
 * 2. `If-Match` = versão da pesquisa (toda gravação de cotação/item a sobe — 412 com `currentVersion`);
 * 3. completude de cada item (422 `PRICE_RESEARCH_INCOMPLETE` com `violations[]` — nada muda);
 * 4. `DocumentFacade.finalizeIn`: `FINALIZED`, versão `FINALIZATION` (snapshot + `contentHash`),
 *    `document.finalize`, `DocumentVersionCreated`, `DocumentFinalized` (= `PriceResearchCompleted`)
 *    e o gancho `finalized` do validador — cabeçalho concluído, `ProcessItem.referenceUnitPrice`,
 *    `Process.estimatedValue` e `price_research.complete`.
 *
 * O ETP vinculado recebe o valor depois, pelo worker (RN-ETP-29). Logs sem valores nem justificativas.
 */

export interface CompletePriceResearchInput {
  readonly researchId: string;
  /** `If-Match` (versão da pesquisa). */
  readonly expectedVersion: number;
  readonly idempotencyKey: string | null;
}

export interface CompletedPriceResearch {
  readonly dto: CompletedPriceResearchDto;
  readonly meta: PriceResearchMeta;
  readonly transition: DocumentTransitionResult;
}

/** Permissão da conclusão no lugar da de edição; as demais travas da POL-02 valem iguais. */
export const COMPLETE_OPTIONS: WritableOptions = {
  permission: COMPLETE_PERMISSION,
  deniedDetail: PRICE_COMPLETION_MESSAGES.permissionDenied,
};

const isApiError = (error: unknown, code: string) =>
  error instanceof ApiError && error.code === code;

function notFound(): ApiError {
  return new ApiError('PRICE_RESEARCH_NOT_FOUND', { detail: PRICE_RESEARCH_MESSAGES.notFound });
}

/** RN-PRICE-59: 422 com uma violação por item pendente (a mensagem resume o tipo de pendência). */
function incomplete(violations: readonly Violation[]): ApiError {
  const codes = new Set(violations.map((violation) => violation.code));
  const detail =
    codes.size > 1
      ? PRICE_COMPLETION_MESSAGES.incomplete
      : codes.has('PRICE_ITEM_BELOW_MINIMUM_UNJUSTIFIED')
        ? PRICE_COMPLETION_MESSAGES.incompleteBelowMinimum
        : PRICE_COMPLETION_MESSAGES.incompleteWithoutPrice;
  return new ApiError('PRICE_RESEARCH_INCOMPLETE', { detail, violations });
}

/** 412 `VERSION_CONFLICT` com a versão atual da pesquisa (a tela recarrega). */
function versionConflict(currentVersion: number): ApiError {
  return new ApiError('VERSION_CONFLICT', {
    detail: PRICE_COMPLETION_MESSAGES.versionConflict,
    extensions: { currentVersion },
  });
}

let durationHistogram: Histogram | undefined;

/** `price_research_complete_duration_ms` (DoD da US-032 — sem valores). */
function recordCompletionDuration(durationMs: number, itemsCount: number): void {
  durationHistogram ??= metrics
    .getMeter('contrataflow-api')
    .createHistogram('price_research_complete_duration_ms', {
      description: 'Duração da conclusão da pesquisa de preços (PRS-23).',
      unit: 'ms',
    });
  durationHistogram.record(durationMs, {
    items: itemsCount > 100 ? '>100' : itemsCount > 10 ? '11-100' : '1-10',
  });
}

@Injectable()
export class CompletePriceResearchCommand extends TransactionalCommandHandler<
  CompletePriceResearchInput,
  undefined,
  CompletedPriceResearch
> {
  constructor(
    @Inject(PRICE_RESEARCH_TRANSACTIONS) transactions: PriceResearchTransactions,
    @Inject(PRICE_RESEARCH_REPOSITORY) private readonly researches: PriceResearchRepository,
    private readonly gate: PriceResearchGate,
    private readonly validator: PriceResearchDocumentValidator,
    private readonly presenter: PriceResearchPresenter,
    private readonly documents: DocumentFacade,
  ) {
    super('price_research.complete', transactions);
  }

  protected prepare(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  protected async handle(
    tx: TenantTx,
    { researchId, expectedVersion, idempotencyKey }: CompletePriceResearchInput,
  ): Promise<CompletedPriceResearch> {
    const context = await this.writable(tx, researchId, expectedVersion);
    const { research, view } = context;
    if (research.version !== expectedVersion) throw versionConflict(research.version);
    const items = await this.researches.listItems(tx, research.id);
    const violations = await this.validator.violationsOf(tx, research, items);
    if (violations.length > 0) {
      this.logger.warn(
        {
          event: 'price_research.complete_blocked',
          priceResearchId: research.id,
          violations: violations.length,
          correlationId: requireRequestContext().correlationId,
        },
        'price_research.complete_blocked',
      );
      throw incomplete(violations);
    }

    const transition = await this.documents.finalizeIn(tx, {
      documentId: research.documentId,
      // O documento dono foi travado pela guarda: a versão lida é a vigente.
      expectedVersion: view.document.version,
      acknowledgedWarnings: [],
      acknowledgeAllWarnings: true,
      idempotencyKey,
    });
    const saved = await this.researches.findById(tx, research.id);
    if (saved === null) throw notFound();
    const { document } = transition;
    return {
      dto: {
        ...this.presenter.research(saved, document, { masked: false }),
        document: { status: document.status, currentVersionId: document.currentVersionId },
      },
      meta: this.presenter.meta(view.template, transition.allowedActions, 'DOCUMENT_NOT_EDITABLE'),
      transition,
    };
  }

  /**
   * A guarda com a permissão da conclusão; 404 próprio e as mensagens da US-032. Documento já
   * concluído com um `If-Match` que não é mais o vigente = o perdedor de duas conclusões
   * simultâneas (a vencedora subiu a versão): 412, não 409.
   */
  private async writable(tx: TenantTx, researchId: string, expectedVersion: number) {
    try {
      return await this.gate.writable(tx, researchId, COMPLETE_OPTIONS);
    } catch (error) {
      if (isApiError(error, 'NOT_FOUND')) throw notFound();
      if (isApiError(error, 'DOCUMENT_NOT_EDITABLE')) {
        const current = await this.researches.findById(tx, researchId);
        if (current !== null && current.version !== expectedVersion) {
          throw versionConflict(current.version);
        }
        throw new ApiError('DOCUMENT_NOT_EDITABLE', {
          detail: PRICE_COMPLETION_MESSAGES.notEditable,
          extensions: (error as ApiError).extensions,
        });
      }
      throw error;
    }
  }

  protected override committed(result: CompletedPriceResearch, durationMs: number): void {
    this.documents.finalizationCommitted(result.transition, durationMs);
    const research: Pick<PriceResearch, 'id' | 'itemsCount' | 'itemsWithAlertsCount'> = result.dto;
    recordCompletionDuration(durationMs, research.itemsCount);
    this.logger.log(
      {
        event: 'price_research.completed',
        priceResearchId: research.id,
        documentVersionId: result.dto.document.currentVersionId,
        itemsCount: research.itemsCount,
        itemsWithAlertsCount: research.itemsWithAlertsCount,
        durationMs,
        correlationId: requireRequestContext().correlationId,
      },
      'price_research.completed',
    );
  }
}
