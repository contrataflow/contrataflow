import type { ProcessItemDto } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { PROCESS_ITEM_REPOSITORY, PROCESS_TRANSACTIONS } from './ports.js';
import type { ProcessItemRepository, ProcessTransactions } from './ports.js';
import { ProcessItemPresenter, ProcessItemsGate } from './process-items.support.js';

export interface ProcessItemList {
  readonly items: ProcessItemDto[];
  /** `ETag` do PRC-13 = versão do processo (o `If-Match` do PRC-17 — RN-PROC-81). */
  readonly processVersion: number;
}

/**
 * `ListProcessItemsQuery` — PRC-13 (fluxo principal, passo 1): só visibilidade (DEC-024 — não
 * visível = 404 `PROCESS_NOT_FOUND`); itens ativos por número, com o preço de referência mascarado
 * pela POL-09 (RN-PROC-84) e a quantidade sempre visível. Lista e versão no mesmo instante
 * (`REPEATABLE READ READ ONLY`).
 */
@Injectable()
export class ListProcessItemsQuery {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) private readonly transactions: ProcessTransactions,
    @Inject(PROCESS_ITEM_REPOSITORY) private readonly items: ProcessItemRepository,
    private readonly gate: ProcessItemsGate,
    private readonly presenter: ProcessItemPresenter,
  ) {}

  execute(processId: string): Promise<ProcessItemList> {
    return this.transactions.snapshot(async (tx) => {
      const context = await this.gate.readable(tx, processId);
      const active = await this.items.listActive(tx, processId);
      return {
        items: await this.presenter.present(tx, active, context),
        processVersion: context.rows.process.version,
      };
    });
  }
}
