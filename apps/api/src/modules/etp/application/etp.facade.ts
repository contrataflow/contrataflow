import { richTextPlainText } from '@contrataflow/validation';
import type {
  AlternativeDecision,
  EtpConclusion,
  EtpEstimatedValueSource,
  ParcelingDecision,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { ETP_ALTERNATIVE_REPOSITORY, ETP_REPOSITORY } from './ports.js';
import type { EtpAlternativeRepository, EtpRepository } from './ports.js';

/**
 * O ETP visto pelo rascunho com IA (US-118 · RN-AI-34/35/36): as decisões tipadas (só para
 * descrever — a IA nunca as altera) e as alternativas cadastradas como texto puro, SEM o custo
 * informado (custo de alternativa nunca vale como estimativa — RN-AI-36).
 */
export interface EtpAiDraftContext {
  readonly id: string;
  readonly processId: string;
  readonly recommendedAlternativeId: string | null;
  readonly parcelingDecision: ParcelingDecision | null;
  readonly conclusion: EtpConclusion;
  /** Decimal(18,2) como string. */
  readonly estimatedTotalValue: string | null;
  readonly estimatedValueSource: EtpEstimatedValueSource | null;
  readonly priceResearchId: string | null;
  readonly alternatives: readonly {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly advantages: string | null;
    readonly disadvantages: string | null;
    readonly decision: AlternativeDecision;
    readonly decisionJustification: string | null;
  }[];
}

/**
 * API pública do módulo `etp` para os demais módulos (DEC-041): métodos de intenção,
 * nunca exposição de repositório. US-021: a fonte `ETP_ALTERNATIVE` da timeline (nome congelado).
 * US-118: o cabeçalho e as alternativas lidos pelo rascunho com IA.
 */
@Injectable()
export class EtpFacade {
  constructor(
    @Inject(ETP_ALTERNATIVE_REPOSITORY) private readonly alternatives: EtpAlternativeRepository,
    @Inject(ETP_REPOSITORY) private readonly etps: EtpRepository,
  ) {}

  /** Nome das alternativas (inclusive excluídas — o fato já aconteceu), no `tx` do chamador. */
  alternativeNames(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<Map<string, { readonly name: string }>> {
    return this.alternatives.names(tx, ids);
  }

  /**
   * US-118 (RN-AI-34): o ETP `etpId` (= `documentId`) com as alternativas não excluídas, no `tx`
   * do chamador (RLS). `null` se inexistente ou de outro tenant. Leitura.
   */
  async aiDraftContextIn(tx: TenantTx, etpId: string): Promise<EtpAiDraftContext | null> {
    const etp = await this.etps.findById(tx, etpId);
    if (etp === null) return null;
    const alternatives = await this.alternatives.listByEtp(tx, etp.id);
    const text = (value: Parameters<typeof richTextPlainText>[0] | null) =>
      value === null ? null : richTextPlainText(value).trim() || null;
    return {
      id: etp.id,
      processId: etp.processId,
      recommendedAlternativeId: etp.recommendedAlternativeId,
      parcelingDecision: etp.parcelingDecision,
      conclusion: etp.conclusion,
      estimatedTotalValue: etp.estimatedTotalValue,
      estimatedValueSource: etp.estimatedValueSource,
      priceResearchId: etp.priceResearchId,
      alternatives: alternatives.map((alternative) => ({
        id: alternative.id,
        name: alternative.name,
        description: text(alternative.description) ?? '',
        advantages: text(alternative.advantages),
        disadvantages: text(alternative.disadvantages),
        decision: alternative.decision,
        decisionJustification: alternative.decisionJustification,
      })),
    };
  }
}
