import {
  evaluateTermCompleteness,
  TERM_ESTIMATED_VALUE_SECTION_KEY,
} from '@contrataflow/validation';
import type { Violation } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { TERM_REPOSITORY } from './ports.js';
import type { TermRepository } from './ports.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import type {
  DocumentValidationSubject,
  DocumentValidator,
  TypedSnapshotParts,
  TypedSummaryFacts,
} from '../../document/application/document.facade.js';
import { ProcessFacade } from '../../process/application/process.facade.js';
import { termSnapshotHeader } from '../domain/term-of-reference.js';

/*
 * `TermDocumentValidator` (US-039 · RN-TR-34..40 · porta `DocumentValidator` da US-065): o módulo
 * `term` só fornece o cabeçalho e as regras `TR_*`; o `document` compõe as genéricas de seção e de
 * campo (RN-TR-13 — o mesmo serviço do indicador do editor) com estas num único `violations[]`. O
 * DOC-08 e a revalidação do DOC-09/DOC-10 na MESMA transação da conclusão (corrida com edição
 * concorrente) usam o mesmo registro. Os avisos de divergência comparam com o ETP `FINALIZED`/
 * `APPROVED` do processo, lido pelo `document` (o `etp` é do mesmo nível). Determinístico e barato
 * (chamado a cada mudança no editor); a análise com IA do MVP 5 (DEC-019) será outro validador.
 * Tudo no `tx` do caso de uso; nunca valores, textos nem especificações no log.
 */

/** ETP que serve de base aos avisos de divergência (RN-TR-36). */
const COMPARABLE_ETP_STATUSES: ReadonlySet<string> = new Set(['FINALIZED', 'APPROVED']);

@Injectable()
export class TermDocumentValidator implements DocumentValidator {
  readonly module = 'TERM_OF_REFERENCE' as const;
  private readonly logger = new Logger('Term');

  constructor(
    @Inject(TERM_REPOSITORY) private readonly terms: TermRepository,
    private readonly documents: DocumentFacade,
    private readonly processes: ProcessFacade,
  ) {}

  async validate(tx: TenantTx, subject: DocumentValidationSubject): Promise<readonly Violation[]> {
    const startedAt = performance.now();
    const term = await this.terms.findById(tx, subject.document.id);
    if (term === null) return [];
    const items = await this.documents.documentItemsIn(tx, subject.document.id);
    const etp = await this.documents.importableEtpIn(tx, subject.document.processId);
    const violations = evaluateTermCompleteness({
      estimatedTotalValue: term.estimatedTotalValue,
      estimatedValueSource: term.estimatedValueSource,
      selectionCriterionId: term.selectionCriterionId,
      awardType: term.awardType,
      productWarrantyMonths: term.productWarrantyMonths,
      contractGuaranteePercent: term.contractGuaranteePercent,
      estimatedValueSection:
        subject.document.draftContent.sections[TERM_ESTIMATED_VALUE_SECTION_KEY],
      items: items.map((item) => ({
        id: item.id,
        processItemId: item.processItemId,
        quantity: item.quantity,
      })),
      etpItems:
        etp !== null && COMPARABLE_ETP_STATUSES.has(etp.status)
          ? etp.items.map((item) => ({
              processItemId: item.processItemId,
              sequence: item.sequence,
              quantity: item.quantity,
            }))
          : null,
    });
    this.logger.debug(
      {
        event: 'document.validation_evaluated',
        documentId: subject.document.id,
        blockingCount: violations.filter((item) => item.severity === 'BLOCKING').length,
        warningCount: violations.filter((item) => item.severity === 'WARNING').length,
        durationMs: Math.round(performance.now() - startedAt),
      },
      'document.validation_evaluated',
    );
    return violations;
  }

  /**
   * `typedSummary` de `DocumentFinalized` (alias `TermCompleted` — RN-TR-37) e do cartão do painel:
   * nunca o valor estimado (só se é sigiloso — POL-09), a quantidade de itens e, na finalização, a
   * de avisos reconhecidos.
   */
  async typedSummary(
    tx: TenantTx,
    subject: DocumentValidationSubject,
    facts?: TypedSummaryFacts,
  ): Promise<Readonly<Record<string, unknown>> | null> {
    const term = await this.terms.findById(tx, subject.document.id);
    if (term === null) return null;
    const items = await this.documents.documentItemsIn(tx, subject.document.id);
    const confidential = await this.processes.isBudgetConfidentialIn(tx, term.processId);
    return {
      estimatedTotalValueMasked: confidential === true,
      itemsCount: items.length,
      ...(facts === undefined
        ? {}
        : { warningsAcknowledgedCount: facts.acknowledgedWarnings.length }),
    };
  }

  /**
   * Snapshot completo da versão (RN-TR-37): o cabeçalho tipado e os itens como o `document` os
   * congela, com a especificação e os critérios de aceitação do TR (US-038).
   */
  async snapshotParts(
    tx: TenantTx,
    subject: DocumentValidationSubject,
  ): Promise<TypedSnapshotParts> {
    const term = await this.terms.findById(tx, subject.document.id);
    if (term === null) return { header: {}, collections: {} };
    const lines = await this.documents.snapshotItemsIn(tx, subject.document);
    const rows = new Map(
      (await this.documents.documentItemsIn(tx, subject.document.id)).map((row) => [
        row.processItemId,
        row,
      ]),
    );
    const items = lines.map((line) => ({
      ...line,
      specification: rows.get(line.processItemId)?.specification ?? null,
      acceptanceCriteria: rows.get(line.processItemId)?.acceptanceCriteria ?? null,
    }));
    return { header: termSnapshotHeader(term), collections: { items } };
  }
}
