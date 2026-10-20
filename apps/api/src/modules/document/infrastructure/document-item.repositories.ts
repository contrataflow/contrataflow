import type { RichTextDocValue } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import { Prisma } from '#shared/database/prisma.js';
import type { TenantTx } from '#shared/database/prisma.js';

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

const richTextOf = (value: Prisma.JsonValue | null): RichTextDocValue | null =>
  value === null ? null : (value as unknown as RichTextDocValue);

function toItem(row: ItemRow): DocumentItem {
  return {
    id: row.id,
    tenantId: row.tenantId,
    documentId: row.documentId,
    processItemId: row.processItemId,
    quantity: row.quantity.toFixed(4),
    notes: row.notes,
    sortOrder: row.sortOrder,
    calculationMemo: richTextOf(row.calculationMemo),
    specification: richTextOf(row.specification),
    acceptanceCriteria: richTextOf(row.acceptanceCriteria),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdById: row.createdById,
    updatedById: row.updatedById,
  };
}

/** `Prisma.DbNull` limpa a coluna JSON (um `null` cru não é aceito pelo Prisma). */
const memoJson = (value: RichTextDocValue | null) =>
  value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);

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
            calculationMemo: memoJson(item.calculationMemo),
            specification: memoJson(item.specification),
            acceptanceCriteria: memoJson(item.acceptanceCriteria),
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
            calculationMemo: memoJson(item.calculationMemo),
            specification: memoJson(item.specification),
            acceptanceCriteria: memoJson(item.acceptanceCriteria),
            updatedAt: item.updatedAt,
            updatedById: item.updatedById,
          },
        });
      }
    }
  }

  async specifiedProcessItemIds(tx: TenantTx, documentId: string): Promise<ReadonlySet<string>> {
    const rows = await tx.documentItem.findMany({
      where: {
        documentId,
        OR: [
          { specification: { not: Prisma.AnyNull } },
          { acceptanceCriteria: { not: Prisma.AnyNull } },
        ],
      },
      select: { processItemId: true },
    });
    return new Set(rows.map((row) => row.processItemId));
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
  private readonly specified = new Set<string>();

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

  specifiedProcessItemIds(_tx: TenantTx, documentId: string): Promise<ReadonlySet<string>> {
    return Promise.resolve(
      new Set(
        this.inTenant()
          .filter(
            (item) =>
              item.documentId === documentId &&
              (this.specified.has(item.id) ||
                item.specification !== null ||
                item.acceptanceCriteria !== null),
          )
          .map((item) => item.processItemId),
      ),
    );
  }

  /** Testes (US-037 · FA-04): marca a linha como especificada sem montar o rich text. */
  markSpecified(itemId: string): void {
    this.specified.add(itemId);
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
