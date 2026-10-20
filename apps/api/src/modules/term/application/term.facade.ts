import type { AwardType, DayCountType, TermEstimatedValueSource } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { TERM_REPOSITORY } from './ports.js';
import type { TermRepository } from './ports.js';

/**
 * O TR visto pelo rascunho com IA (US-120 · RN-AI-43/44/46): as condições contratuais tipadas (a
 * única fonte de prazos, pagamento, garantias e local — a IA nunca as altera) e o valor estimado
 * com a origem e a pesquisa vinculada. Sem pessoas nem a rastreabilidade da importação.
 */
export interface TermAiDraftContext {
  readonly id: string;
  readonly processId: string;
  readonly contractDurationMonths: number | null;
  readonly executionDeadline: number | null;
  readonly executionDeadlineType: DayCountType | null;
  readonly deliveryLocation: string | null;
  readonly paymentTermDays: number | null;
  readonly productWarrantyMonths: number | null;
  /** Decimal(9,4) como string. */
  readonly contractGuaranteePercent: string | null;
  readonly allowsSubcontracting: boolean | null;
  readonly selectionCriterionId: string | null;
  readonly awardType: AwardType | null;
  /** Decimal(18,2) como string. */
  readonly estimatedTotalValue: string | null;
  readonly estimatedValueSource: TermEstimatedValueSource | null;
  readonly priceResearchId: string | null;
}

/**
 * API pública do módulo `term` para os demais módulos (DEC-041): métodos de intenção,
 * nunca exposição de repositório. US-120: o cabeçalho tipado lido pelo rascunho com IA.
 */
@Injectable()
export class TermFacade {
  constructor(@Inject(TERM_REPOSITORY) private readonly terms: TermRepository) {}

  /**
   * US-120 (RN-AI-43): o TR `termId` (= `documentId`), no `tx` do chamador (RLS). `null` se
   * inexistente ou de outro tenant. Leitura.
   */
  async aiDraftContextIn(tx: TenantTx, termId: string): Promise<TermAiDraftContext | null> {
    const term = await this.terms.findById(tx, termId);
    if (term === null) return null;
    return {
      id: term.id,
      processId: term.processId,
      contractDurationMonths: term.contractDurationMonths,
      executionDeadline: term.executionDeadline,
      executionDeadlineType: term.executionDeadlineType,
      deliveryLocation: term.deliveryLocation,
      paymentTermDays: term.paymentTermDays,
      productWarrantyMonths: term.productWarrantyMonths,
      contractGuaranteePercent: term.contractGuaranteePercent,
      allowsSubcontracting: term.allowsSubcontracting,
      selectionCriterionId: term.selectionCriterionId,
      awardType: term.awardType,
      estimatedTotalValue: term.estimatedTotalValue,
      estimatedValueSource: term.estimatedValueSource,
      priceResearchId: term.priceResearchId,
    };
  }
}
