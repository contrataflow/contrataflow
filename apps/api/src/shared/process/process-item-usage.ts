import { Injectable, Module } from '@nestjs/common';

import type { TenantTx } from '../database/prisma.js';

/*
 * Uso de um item canônico do processo (`ProcessItem` — US-006 · DEC-019 · RN-PROC-76/79). Os itens
 * são do módulo `process` (nível 3), mas quem os referencia vive em `document` (`DocumentItem` —
 * DFD/ETP/TR) e em `price-research` (`PriceItem`, nível 4): para não depender de módulo acima, o
 * `process` pergunta a esta porta do shared kernel, e cada dono registra o SEU leitor no
 * `onModuleInit` (mesmo arranjo do `AttachmentTargetRegistry`). Sem leitor registrado (antes das
 * stories donas — US-014/US-022/US-024/US-038), nenhum item está em uso.
 *
 * Corrida exclusão × inclusão (story · "Impacto técnico"): o `process` trava a linha do item
 * (`FOR UPDATE`) antes de perguntar; o dono, ao gravar a referência, valida o item com
 * `SELECT … FOR SHARE` — um dos dois espera o outro e falha de forma consistente.
 */

/** Um documento (ou pesquisa) que referencia o item (`meta.references` do 409 `ITEM_IN_USE`). */
export interface ProcessItemUsage {
  readonly itemId: string;
  readonly documentId: string;
  /** Código de exibição (`DFD 0005/2026`, `PP 0002/2026`). */
  readonly code: string;
  readonly typeCode: string;
  readonly status: string;
  /** `DRAFT`/`RETURNED`: basta remover o item do documento; senão, reabrir antes (US-065). */
  readonly editable: boolean;
}

export interface ProcessItemUsageReader {
  /** Referências aos itens no tenant da transação (RLS), no `tx` do chamador. */
  findItemReferences(tx: TenantTx, itemIds: readonly string[]): Promise<ProcessItemUsage[]>;
}

/** Registro dos leitores (um por módulo dono de referência). */
@Injectable()
export class ProcessItemUsageRegistry {
  private readonly readers: ProcessItemUsageReader[] = [];

  register(reader: ProcessItemUsageReader): void {
    this.readers.push(reader);
  }

  /** Referências de todos os leitores, por item (itens sem referência ficam fora do mapa). */
  async findItemReferences(
    tx: TenantTx,
    itemIds: readonly string[],
  ): Promise<Map<string, ProcessItemUsage[]>> {
    const byItem = new Map<string, ProcessItemUsage[]>();
    if (itemIds.length === 0) return byItem;
    for (const reader of this.readers) {
      for (const usage of await reader.findItemReferences(tx, itemIds)) {
        byItem.set(usage.itemId, [...(byItem.get(usage.itemId) ?? []), usage]);
      }
    }
    return byItem;
  }
}

/** Importado por `process` (consumidor) e pelos donos das referências; a instância é única. */
@Module({
  providers: [ProcessItemUsageRegistry],
  exports: [ProcessItemUsageRegistry],
})
export class ProcessItemUsageModule {}
