import { ETP_MESSAGES } from '@contrataflow/validation';
import type {
  EtpDetailDto,
  EtpDetailMeta,
  EtpListMeta,
  EtpSummaryDto,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { ApiError } from '#shared/errors/api-error.js';

import {
  toEtpDetailDto,
  toEtpDetailMeta,
  toEtpSummaryDto,
  toImportableDfdDto,
} from './etp.presenter.js';
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

/** 404 único do ETP-03: inexistente, de outro tenant, excluído ou de processo não visível. */
export function etpNotFound(): ApiError {
  return new ApiError('NOT_FOUND', { detail: ETP_MESSAGES.notFound });
}

export interface EtpView {
  readonly dto: EtpDetailDto;
  readonly meta: EtpDetailMeta;
}

/*
 * ETP-03 — Obter ETP (US-020 · SCR-008): `PROCESS_VIEW` pela visibilidade do processo (DEC-024 —
 * 404 `NOT_FOUND` indistinguível), POL-09 no valor estimado. O rascunho por seção (com a revisão
 * do `If-Match` do DOC-05), as ações (`UPDATE` só com ETP_UPDATE + POL-02 e o ETP editável — a
 * tela abre somente leitura sem ela) e as seções da versão do template. Sem auditoria nem eventos.
 */
@Injectable()
export class GetEtpQuery {
  constructor(
    @Inject(ETP_TRANSACTIONS) private readonly transactions: EtpTransactions,
    @Inject(ETP_REPOSITORY) private readonly etps: EtpRepository,
    private readonly documents: DocumentFacade,
  ) {}

  execute(etpId: string): Promise<EtpView> {
    return this.transactions.read(async (tx) => {
      const etp = await this.etps.findById(tx, etpId);
      if (etp === null) throw etpNotFound();
      const view = await this.documents.typedDocumentIn(tx, etp.documentId);
      if (view === null) throw etpNotFound();
      const items = await this.documents.documentItemsIn(tx, etp.documentId);
      return {
        dto: toEtpDetailDto(etp, view.document, items.length, {
          masked: view.isBudgetConfidential && !view.canViewConfidentialBudget,
        }),
        meta: toEtpDetailMeta(view.template, view.allowedActions),
      };
    });
  }
}
