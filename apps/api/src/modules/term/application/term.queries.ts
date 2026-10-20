import { TERM_MESSAGES, termDocumentTitle } from '@contrataflow/validation';
import type {
  TermDetailDto,
  TermDetailMeta,
  TermListMeta,
  TermSummaryDto,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';
import { PriceResearchSummaryRegistry } from '#shared/price-research/price-research-summary.js';
import type { PriceResearchSummary } from '#shared/price-research/price-research-summary.js';

import { TERM_REPOSITORY, TERM_TRANSACTIONS } from './ports.js';
import type { TermRepository, TermTransactions } from './ports.js';
import {
  toTermCompleteness,
  toTermDetailDto,
  toTermDetailMeta,
  toTermSummaryDto,
  toTermTemplateOption,
} from './term.presenter.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import type { TypedDocumentView } from '../../document/application/document.facade.js';
import { etpChangedSinceImport } from '../domain/etp-import.js';
import type { TermOfReference } from '../domain/term-of-reference.js';

/*
 * TRM-01 — Listar TRs do processo (US-036): `PROCESS_VIEW` pela visibilidade do processo (DEC-024 —
 * inexistente, de outro tenant ou não visível = 404 `NOT_FOUND`). Somente leitura: sem auditoria
 * nem eventos. `meta` traz o que o diálogo "Criar Termo de Referência" precisa (FA-01): os modelos
 * publicados do tipo TR (o padrão primeiro) e o título padrão.
 */

export interface TermList {
  readonly items: TermSummaryDto[];
  readonly meta: TermListMeta;
}

@Injectable()
export class ListProcessTermsQuery {
  constructor(
    @Inject(TERM_TRANSACTIONS) private readonly transactions: TermTransactions,
    @Inject(TERM_REPOSITORY) private readonly terms: TermRepository,
    private readonly documents: DocumentFacade,
  ) {}

  execute(processId: string): Promise<TermList> {
    return this.transactions.read(async (tx) => {
      const { processTitle } = await this.documents.typedCollectionStateIn(tx, {
        processId,
        systemModule: 'TERM_OF_REFERENCE',
      });
      const terms = await this.terms.listByProcess(tx, processId);
      const states = await this.documents.documentStatesIn(
        tx,
        terms.map((term) => term.documentId),
      );
      const items = terms.flatMap((term) => {
        const state = states.get(term.documentId);
        return state === undefined ? [] : [toTermSummaryDto(term, state)];
      });
      const templates = await this.documents.publishedTemplatesIn(tx, 'TERM_OF_REFERENCE');
      return {
        items,
        meta: {
          templates: templates.map(toTermTemplateOption),
          defaultTitle: termDocumentTitle(processTitle),
        },
      };
    });
  }
}

/** 404 único do TRM-03/04: inexistente, de outro tenant, excluído ou de processo não visível. */
export function termNotFound(): ApiError {
  return new ApiError('NOT_FOUND', { detail: TERM_MESSAGES.notFound });
}

export interface TermView {
  readonly dto: TermDetailDto;
  readonly meta: TermDetailMeta;
}

/** O TR com as pesquisas do processo e a completude (TRM-03 e a resposta do TRM-04). */
export async function readTermDetail(
  tx: TenantTx,
  term: TermOfReference,
  view: TypedDocumentView,
  documents: DocumentFacade,
  researches: PriceResearchSummaryRegistry,
): Promise<TermView> {
  const masked = view.isBudgetConfidential && !view.canViewConfidentialBudget;
  const all = await researches.listByProcess(tx, term.processId);
  const linked: PriceResearchSummary | null =
    term.priceResearchId === null
      ? null
      : (all.find((summary) => summary.id === term.priceResearchId) ?? null);
  const completed = await researches.completedOf(tx, term.processId);
  const sections = (await documents.sectionCompletenessIn(tx, term.documentId)) ?? [];
  const etp =
    term.importedFromEtpId === null
      ? null
      : ((await documents.documentStatesIn(tx, [term.importedFromEtpId])).get(
          term.importedFromEtpId,
        ) ?? null);
  return {
    dto: toTermDetailDto(
      term,
      view,
      {
        completeness: toTermCompleteness(sections),
        priceResearch: linked,
        completedPriceResearch: completed,
        etpChangedSinceImport: etpChangedSinceImport(term, etp),
      },
      { masked },
    ),
    meta: toTermDetailMeta(view.template, view.allowedActions),
  };
}

/*
 * TRM-03 — Obter TR (US-036 · SCR-012): `PROCESS_VIEW` pela visibilidade do processo (DEC-024 — 404
 * `NOT_FOUND` indistinguível), POL-09 no valor estimado (FA-05). O rascunho por seção (com a revisão
 * do `If-Match` do DOC-05), a completude (RN-TR-13 — a avaliação do DOC-08), as ações (`UPDATE` só
 * com TERM_UPDATE + POL-02 e o TR editável — a tela abre somente leitura sem ela) e as seções da
 * versão do template. Sem auditoria nem eventos.
 */
@Injectable()
export class GetTermQuery {
  constructor(
    @Inject(TERM_TRANSACTIONS) private readonly transactions: TermTransactions,
    @Inject(TERM_REPOSITORY) private readonly terms: TermRepository,
    private readonly documents: DocumentFacade,
    private readonly researches: PriceResearchSummaryRegistry,
  ) {}

  execute(termId: string): Promise<TermView> {
    return this.transactions.read(async (tx) => {
      const term = await this.terms.findById(tx, termId);
      if (term === null) throw termNotFound();
      const view = await this.documents.typedDocumentIn(tx, term.documentId);
      if (view === null) throw termNotFound();
      return readTermDetail(tx, term, view, this.documents, this.researches);
    });
  }
}
