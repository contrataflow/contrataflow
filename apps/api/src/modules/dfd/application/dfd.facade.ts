import type { PcaStatus, Priority } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { DFD_REPOSITORY } from './ports.js';
import type { DfdRepository } from './ports.js';

/** Cabeçalho tipado do DFD visto pelo gerador de IA (US-117 · RN-AI-26) — sem pessoas. */
export interface DfdAiDraftHeader {
  readonly documentId: string;
  readonly processId: string;
  readonly requestingDepartmentId: string;
  readonly objectSummary: string;
  readonly priority: Priority;
  /** `AAAA-MM-DD`. */
  readonly requestDate: string;
  readonly expectedDate: string | null;
  /** Decimal(18,2) como string; o sigilo (DEC-030) é de quem chama. */
  readonly estimatedValue: string | null;
  readonly pcaStatus: PcaStatus;
  readonly pcaYear: number | null;
  readonly pcaItemCode: string | null;
}

/**
 * API pública do módulo `dfd` para os demais módulos (DEC-041): métodos de intenção,
 * nunca exposição de repositório.
 */
@Injectable()
export class DfdFacade {
  constructor(@Inject(DFD_REPOSITORY) private readonly dfds: DfdRepository) {}

  /**
   * Cabeçalho do DFD para o contexto da geração com IA (US-117), no `tx` do chamador (RLS). Sem o
   * responsável pela demanda (pessoa — RN-AI-05). `null` = inexistente no tenant.
   */
  async aiDraftHeaderIn(tx: TenantTx, documentId: string): Promise<DfdAiDraftHeader | null> {
    const dfd = await this.dfds.findById(tx, documentId);
    if (dfd === null) return null;
    return {
      documentId: dfd.documentId,
      processId: dfd.processId,
      requestingDepartmentId: dfd.requestingDepartmentId,
      objectSummary: dfd.objectSummary,
      priority: dfd.priority,
      requestDate: dfd.requestDate,
      expectedDate: dfd.expectedDate,
      estimatedValue: dfd.estimatedValue,
      pcaStatus: dfd.pcaStatus,
      pcaYear: dfd.pcaYear,
      pcaItemCode: dfd.pcaItemCode,
    };
  }
}
