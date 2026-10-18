import { Injectable, Module } from '@nestjs/common';

import type { TenantTx } from '../database/prisma.js';

/*
 * Itens canônicos do processo vistos pelos documentos (US-014 · DEC-019 · RN-DFD-14). Os itens são
 * do módulo `process` (nível 3), mas o DOC-06/07 (`DocumentItem`) vive em `document` (nível 2): para
 * não depender de módulo acima, o `document` pergunta a esta porta do shared kernel e o `process`
 * registra o leitor no `onModuleInit` (mesmo arranjo do `DocumentProcessContextRegistry`). Sem
 * leitor registrado, o processo não tem itens (DOC-07 recusa qualquer referência — falha fechado).
 *
 * Corrida inclusão no documento × exclusão do item (US-006 · "Impacto técnico"): `lockForShare`
 * lê os itens com `SELECT … FOR SHARE`; a exclusão (PRC-16) trava a linha com `FOR UPDATE` e pergunta
 * ao `ProcessItemUsageRegistry` — um dos dois espera o outro e falha de forma consistente.
 */

/** Item não excluído do processo, como os documentos o referenciam. */
export interface ProcessItemReference {
  readonly id: string;
  readonly processId: string;
  readonly sequence: number;
  /** Lote (RN-PROC-74) — exibição e filtro da pesquisa de preços (US-024 · PRS-05). */
  readonly lotNumber: number | null;
  readonly lotName: string | null;
  readonly description: string;
  readonly unitOfMeasureId: string;
  /** Decimal(18,4) como string (sugestão da quantidade no DFD — fluxo principal 9). */
  readonly referenceQuantity: string | null;
}

export interface ProcessItemCatalogReader {
  /** Itens não excluídos do processo por `sequence` (RLS: de outro tenant = nenhum). */
  listActive(tx: TenantTx, processId: string): Promise<ProcessItemReference[]>;
  /**
   * Itens não excluídos do processo dentre `itemIds`, travados com `FOR SHARE` até o fim do `tx`.
   * Ids de outro processo, excluídos ou de outro tenant ficam de fora.
   */
  lockForShare(
    tx: TenantTx,
    processId: string,
    itemIds: readonly string[],
  ): Promise<ProcessItemReference[]>;
}

/** Registro do leitor (implementado pelo módulo `process`). */
@Injectable()
export class ProcessItemCatalogRegistry {
  private reader: ProcessItemCatalogReader | null = null;

  register(reader: ProcessItemCatalogReader): void {
    this.reader = reader;
  }

  listActive(tx: TenantTx, processId: string): Promise<ProcessItemReference[]> {
    return this.reader ? this.reader.listActive(tx, processId) : Promise.resolve([]);
  }

  lockForShare(
    tx: TenantTx,
    processId: string,
    itemIds: readonly string[],
  ): Promise<ProcessItemReference[]> {
    if (this.reader === null || itemIds.length === 0) return Promise.resolve([]);
    return this.reader.lockForShare(tx, processId, itemIds);
  }
}

/** Importado por `document` (consumidor) e `process` (implementador); a instância é única. */
@Module({
  providers: [ProcessItemCatalogRegistry],
  exports: [ProcessItemCatalogRegistry],
})
export class ProcessItemCatalogModule {}
