import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import type { Prisma, TenantTx } from '#shared/database/prisma.js';

import type {
  DocumentItemReference,
  DocumentItemRepository,
} from '../application/document-items.ports.js';
import type { DocumentItem } from '../domain/document-items.js';

/*
 * `document_items` (US-014): no PostgreSQL sempre no `tx` da `TenantTransaction` (RLS do tenant +
 * extensão de isolamento); em memória para os testes e o modo de identidade fake (isolados pelo
 * tenant do contexto, como a RLS). O caso de uso já travou o documento (`FOR UPDATE`): duas
 * substituições da mesma coleção são serializadas.
 */

type ItemRow = Prisma.DocumentItemGetPayload<object>;

function toItem(row: ItemRow): DocumentItem {
  return {
    id: row.id,
    tenantId: row.tenantId,
    documentId: row.documentId,
    processItemId: row.processItemId,
    quantity: row.quantity.toFixed(4),
    notes: row.notes,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdById: row.createdById,
    updatedById: row.updatedById,
  };
}

const bySortOrder = (a: DocumentItem, b: DocumentItem) =>
  a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime();

@Injectable()
export class PrismaDocumentItemRepository implements DocumentItemRepository {
  async listByDocument(tx: TenantTx, documentId: string): Promise<DocumentItem[]> {
    const rows = await tx.documentItem.findMany({
      where: { documentId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toItem);
  }

  async replace(tx: TenantTx, documentId: string, items: readonly DocumentItem[]): Promise<void> {
    const current = await this.listByDocument(tx, documentId);
    const keep = new Set(items.map((item) => item.id));
    const removed = current.filter((item) => !keep.has(item.id)).map((item) => item.id);
    if (removed.length > 0) {
      await tx.documentItem.deleteMany({ where: { documentId, id: { in: removed } } });
    }
    const existing = new Map(current.map((item) => [item.id, item]));
    for (const item of items) {
      const before = existing.get(item.id);
      if (before === undefined) {
        await tx.documentItem.create({
          data: {
            id: item.id,
            tenantId: item.tenantId,
            documentId: item.documentId,
            processItemId: item.processItemId,
            quantity: item.quantity,
            notes: item.notes,
            sortOrder: item.sortOrder,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            createdById: item.createdById,
            updatedById: item.updatedById,
          },
          select: { id: true },
        });
      } else if (before !== item) {
        await tx.documentItem.updateMany({
          where: { id: item.id, documentId },
          data: {
            quantity: item.quantity,
            notes: item.notes,
            sortOrder: item.sortOrder,
            updatedAt: item.updatedAt,
            updatedById: item.updatedById,
          },
        });
      }
    }
  }

  async referencesTo(
    tx: TenantTx,
    processItemIds: readonly string[],
  ): Promise<DocumentItemReference[]> {
    if (processItemIds.length === 0) return [];
    return tx.documentItem.findMany({
      where: { processItemId: { in: [...processItemIds] } },
      select: { processItemId: true, documentId: true },
    });
  }
}

/** Itens de documento em memória: mesma semântica do adaptador Prisma, isolados pelo tenant. */
@Injectable()
export class InMemoryDocumentItemRepository implements DocumentItemRepository {
  private readonly rows = new Map<string, DocumentItem>();

  private inTenant(): DocumentItem[] {
    const tenantId = currentRequestContext()?.tenantId ?? null;
    return [...this.rows.values()].filter((item) => item.tenantId === tenantId);
  }

  listByDocument(_tx: TenantTx, documentId: string): Promise<DocumentItem[]> {
    return Promise.resolve(
      this.inTenant()
        .filter((item) => item.documentId === documentId)
        .sort(bySortOrder),
    );
  }

  replace(_tx: TenantTx, documentId: string, items: readonly DocumentItem[]): Promise<void> {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.processItemId)) {
        return Promise.reject(new Error('document_items_document_process_item_key: item repetido'));
      }
      seen.add(item.processItemId);
    }
    for (const item of this.inTenant()) {
      if (item.documentId === documentId) this.rows.delete(item.id);
    }
    for (const item of items) this.rows.set(item.id, item);
    return Promise.resolve();
  }

  referencesTo(_tx: TenantTx, processItemIds: readonly string[]): Promise<DocumentItemReference[]> {
    const wanted = new Set(processItemIds);
    return Promise.resolve(
      this.inTenant()
        .filter((item) => wanted.has(item.processItemId))
        .map(({ processItemId, documentId }) => ({ processItemId, documentId })),
    );
  }

  /** Inspeção de testes: todas as linhas (de todos os tenants). */
  snapshot(): readonly DocumentItem[] {
    return [...this.rows.values()];
  }
}
