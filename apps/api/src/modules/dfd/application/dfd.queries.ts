import type { DfdDto, DfdMeta, DfdSummaryDto } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { ApiError } from '#shared/errors/api-error.js';

import { toDfdDto, toDfdMeta, toDfdSummaryDto } from './dfd.presenter.js';
import { DFD_REPOSITORY, DFD_TRANSACTIONS } from './ports.js';
import type { DfdRepository, DfdTransactions } from './ports.js';
import { DocumentFacade } from '../../document/application/document.facade.js';

/*
 * Consultas do DFD (US-014 · DFD-01/DFD-03): `PROCESS_VIEW` pela visibilidade do processo
 * (DEC-024). DFD inexistente, de outro tenant, com documento excluído ou de processo não visível →
 * 404 `DFD_NOT_FOUND` indistinguível. Somente leitura: sem auditoria nem eventos.
 */

export function dfdNotFound(): ApiError {
  return new ApiError('DFD_NOT_FOUND', { detail: 'DFD não encontrado.' });
}

export interface DfdView {
  readonly dto: DfdDto;
  readonly meta: DfdMeta;
}

@Injectable()
export class GetDfdQuery {
  constructor(
    @Inject(DFD_TRANSACTIONS) private readonly transactions: DfdTransactions,
    @Inject(DFD_REPOSITORY) private readonly dfds: DfdRepository,
    private readonly documents: DocumentFacade,
  ) {}

  /** DFD-03: o cabeçalho, o resumo do documento e `meta.allowedActions` (POL-09 na estimativa). */
  execute(dfdId: string): Promise<DfdView> {
    return this.transactions.read(async (tx) => {
      const dfd = await this.dfds.findById(tx, dfdId);
      if (dfd === null) throw dfdNotFound();
      const view = await this.documents.typedDocumentIn(tx, dfd.documentId);
      if (view === null) throw dfdNotFound();
      return {
        dto: toDfdDto(dfd, view.document, {
          masked: view.isBudgetConfidential && !view.canViewConfidentialBudget,
        }),
        meta: toDfdMeta(view.template, view.allowedActions),
      };
    });
  }
}

@Injectable()
export class ListProcessDfdsQuery {
  constructor(
    @Inject(DFD_TRANSACTIONS) private readonly transactions: DfdTransactions,
    @Inject(DFD_REPOSITORY) private readonly dfds: DfdRepository,
    private readonly documents: DocumentFacade,
  ) {}

  /** DFD-01: 0 ou 1 ativo + cancelados (excluídos logicamente ficam de fora — FA-12). */
  execute(processId: string): Promise<DfdSummaryDto[]> {
    return this.transactions.read(async (tx) => {
      // Processo inexistente, de outro tenant ou não visível → 404 `NOT_FOUND` (DEC-024).
      await this.documents.typedCollectionStateIn(tx, { processId, systemModule: 'DFD' });
      const dfds = await this.dfds.listByProcess(tx, processId);
      const states = await this.documents.documentStatesIn(
        tx,
        dfds.map((dfd) => dfd.documentId),
      );
      return dfds.flatMap((dfd) => {
        const state = states.get(dfd.documentId);
        return state === undefined ? [] : [toDfdSummaryDto(dfd, state)];
      });
    });
  }
}
