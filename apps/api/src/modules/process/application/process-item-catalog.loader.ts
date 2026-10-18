import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import type {
  ProcessItemCatalogReader,
  ProcessItemReference,
} from '#shared/process/process-item-catalog.js';

import { PROCESS_ITEM_REPOSITORY } from './ports.js';
import type { ProcessItemRepository } from './ports.js';
import type { ProcessItem } from '../domain/process-items.js';

const referenceOf = (item: ProcessItem): ProcessItemReference => ({
  id: item.id,
  processId: item.processId,
  sequence: item.sequence,
  description: item.description,
  unitOfMeasureId: item.unitOfMeasureId,
  referenceQuantity: item.referenceQuantity,
});

/**
 * Lado `process` da porta `ProcessItemCatalogRegistry` (US-014): os itens não excluídos do processo
 * como os documentos os referenciam (DOC-06/07), no `tx` do caso de uso (RLS do tenant).
 */
@Injectable()
export class ProcessItemCatalogLoader implements ProcessItemCatalogReader {
  constructor(@Inject(PROCESS_ITEM_REPOSITORY) private readonly items: ProcessItemRepository) {}

  async listActive(tx: TenantTx, processId: string): Promise<ProcessItemReference[]> {
    return (await this.items.listActive(tx, processId)).map(referenceOf);
  }

  async lockForShare(
    tx: TenantTx,
    processId: string,
    itemIds: readonly string[],
  ): Promise<ProcessItemReference[]> {
    return (await this.items.lockForShare(tx, processId, itemIds)).map(referenceOf);
  }
}
