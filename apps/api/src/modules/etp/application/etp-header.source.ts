import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import type { EtpHeader, EtpHeaderReader } from '#shared/etp/etp-header.js';

import { ETP_REPOSITORY } from './ports.js';
import type { EtpRepository } from './ports.js';

/**
 * Leitor do cabeçalho do ETP para a porta `EtpHeaderRegistry` (US-037 · RN-TR-17/22): o valor
 * estimado e a pesquisa vinculada que a importação leva para o TR, no `tx` do chamador (RLS).
 * Registrado no `onModuleInit` do `EtpModule`.
 */
@Injectable()
export class EtpHeaderSource implements EtpHeaderReader {
  constructor(@Inject(ETP_REPOSITORY) private readonly etps: EtpRepository) {}

  async findById(tx: TenantTx, id: string): Promise<EtpHeader | null> {
    const etp = await this.etps.findById(tx, id);
    if (etp === null) return null;
    return {
      id: etp.id,
      processId: etp.processId,
      estimatedTotalValue: etp.estimatedTotalValue,
      priceResearchId: etp.priceResearchId,
      version: etp.version,
    };
  }
}
