import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { RISK_REPOSITORY } from './ports.js';
import type { RiskRepository } from './ports.js';

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
}
