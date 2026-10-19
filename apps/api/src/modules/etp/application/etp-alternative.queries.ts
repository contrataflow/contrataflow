import type { EtpAlternativeDto, EtpAlternativeListMeta } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { EtpAlternativeGate, toAlternativeDto } from './etp-alternative.support.js';
import { ETP_ALTERNATIVE_REPOSITORY, ETP_TRANSACTIONS } from './ports.js';
import type { EtpAlternativeRepository, EtpTransactions } from './ports.js';

/*
 * ETP-05 — Listar alternativas do ETP (US-021 · RN-ETP-23): `PROCESS_VIEW` pela visibilidade do
 * processo (DEC-024 — ETP inexistente, de outro tenant ou não visível = 404 `NOT_FOUND`), POL-09 no
 * custo (RN-ETP-24). As não excluídas por `sortOrder`; `meta.canManage` decide se a seção abre
 * editável (`ETP_UPDATE` + POL-02 + ETP em `DRAFT`/`RETURNED`). Sem auditoria nem eventos.
 */

export interface EtpAlternativeList {
  readonly items: EtpAlternativeDto[];
  readonly meta: EtpAlternativeListMeta;
}

@Injectable()
export class ListEtpAlternativesQuery {
  constructor(
    @Inject(ETP_TRANSACTIONS) private readonly transactions: EtpTransactions,
    @Inject(ETP_ALTERNATIVE_REPOSITORY) private readonly alternatives: EtpAlternativeRepository,
    private readonly gate: EtpAlternativeGate,
  ) {}

  execute(etpId: string): Promise<EtpAlternativeList> {
    return this.transactions.read(async (tx) => {
      const { etp, masked, canManage } = await this.gate.readable(tx, etpId);
      const rows = await this.alternatives.listByEtp(tx, etp.id);
      return {
        items: rows.map((row) => toAlternativeDto(row, { masked })),
        meta: {
          canManage,
          recommendedAlternativeId: etp.recommendedAlternativeId,
          estimatedCostMasked: masked,
        },
      };
    });
  }
}
