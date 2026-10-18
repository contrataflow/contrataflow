import type { RiskLevel, RiskPhase, TreatmentType } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { RISK_REPOSITORY } from './ports.js';
import type { RiskRepository } from './ports.js';

/** Risco já registrado como entrada da proposta de IA (US-119 · RN-AI-38): sem pessoas nem valores. */
export interface RiskAiContextEntry {
  readonly id: string;
  readonly code: string;
  readonly title: string;
  readonly categoryId: string;
  readonly phase: RiskPhase;
  readonly level: RiskLevel;
  readonly treatments: readonly { readonly type: TreatmentType; readonly description: string }[];
}

/**
 * API pública do módulo `risk` para os demais módulos (DEC-041): métodos de intenção,
 * nunca exposição de repositório. US-033: a fonte `RISK` da timeline (código e título congelados).
 */
@Injectable()
export class RiskFacade {
  constructor(@Inject(RISK_REPOSITORY) private readonly risks: RiskRepository) {}

  /** Código e título dos riscos (inclusive excluídos — o fato já aconteceu), no `tx` do chamador. */
  riskLabels(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<Map<string, { readonly code: string; readonly title: string }>> {
    return this.risks.labels(tx, ids);
  }

  /**
   * Riscos não excluídos do processo (título, categoria, fase, nível e tratamentos ativos) para o
   * contexto da proposta de IA — evita duplicidade (US-119 · RN-AI-38). Nunca responsável, prazo,
   * observações nem causa/consequência. No `tx` do chamador (RLS).
   */
  async aiContextIn(tx: TenantTx, processId: string): Promise<RiskAiContextEntry[]> {
    const risks = await this.risks.listByProcess(tx, processId, {});
    if (risks.length === 0) return [];
    const treatments = await this.risks.treatmentsOf(
      tx,
      risks.map((risk) => risk.id),
    );
    return risks.map((risk) => ({
      id: risk.id,
      code: risk.code,
      title: risk.title,
      categoryId: risk.categoryId,
      phase: risk.phase,
      level: risk.level,
      treatments: treatments
        .filter((treatment) => treatment.riskId === risk.id && treatment.status !== 'CANCELED')
        .map((treatment) => ({ type: treatment.type, description: treatment.description })),
    }));
  }
}
