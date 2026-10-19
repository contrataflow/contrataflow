import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { ETP_ALTERNATIVE_REPOSITORY } from './ports.js';
import type { EtpAlternativeRepository } from './ports.js';

/**
 * API pública do módulo `etp` para os demais módulos (DEC-041): métodos de intenção,
 * nunca exposição de repositório. US-021: a fonte `ETP_ALTERNATIVE` da timeline (nome congelado).
 */
@Injectable()
export class EtpFacade {
  constructor(
    @Inject(ETP_ALTERNATIVE_REPOSITORY) private readonly alternatives: EtpAlternativeRepository,
  ) {}

  /** Nome das alternativas (inclusive excluídas — o fato já aconteceu), no `tx` do chamador. */
  alternativeNames(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<Map<string, { readonly name: string }>> {
    return this.alternatives.names(tx, ids);
  }
}
