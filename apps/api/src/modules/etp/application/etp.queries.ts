import type { EtpListMeta, EtpSummaryDto } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { toEtpSummaryDto, toImportableDfdDto } from './etp.presenter.js';
import { ETP_REPOSITORY, ETP_TRANSACTIONS } from './ports.js';
import type { EtpRepository, EtpTransactions } from './ports.js';
import { DocumentFacade } from '../../document/application/document.facade.js';

/*
 * ETP-01 — Listar ETPs do processo (US-019): `PROCESS_VIEW` pela visibilidade do processo (DEC-024 —
 * inexistente, de outro tenant ou não visível = 404 `NOT_FOUND`). Somente leitura: sem auditoria
 * nem eventos. `meta.importableDfd` é o DFD elegível para a importação pela MESMA regra do ETP-02.
 */

export interface EtpList {
  readonly items: EtpSummaryDto[];
  readonly meta: EtpListMeta;
}

@Injectable()
export class ListProcessEtpsQuery {
  constructor(
    @Inject(ETP_TRANSACTIONS) private readonly transactions: EtpTransactions,
    @Inject(ETP_REPOSITORY) private readonly etps: EtpRepository,
    private readonly documents: DocumentFacade,
  ) {}

  execute(processId: string): Promise<EtpList> {
    return this.transactions.read(async (tx) => {
      await this.documents.typedCollectionStateIn(tx, { processId, systemModule: 'ETP' });
      const etps = await this.etps.listByProcess(tx, processId);
      const states = await this.documents.documentStatesIn(
        tx,
        etps.map((etp) => etp.documentId),
      );
      const items = etps.flatMap((etp) => {
        const state = states.get(etp.documentId);
        return state === undefined ? [] : [toEtpSummaryDto(etp, state)];
      });
      const source = await this.documents.importableDfdIn(tx, processId);
      return {
        items,
        meta: { importableDfd: source === null ? null : toImportableDfdDto(source) },
      };
    });
  }
}
