import { Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';

import { requireRequestContext } from '#shared/context/request-context.js';
import type { Prisma, TenantTx } from '#shared/database/prisma.js';

import type { ProcessItemRepository, ProcessItemStats } from '../application/ports.js';
import type { ProcessItem } from '../domain/process-items.js';

/*
 * `process_items` (US-006): no PostgreSQL sempre no `tx` da `TenantTransaction` (RLS do tenant +
 * extensão de isolamento); em memória para os testes e o modo de identidade fake (isolados pelo
 * tenant do contexto, como a RLS). O comando já travou o processo: inclusões, renumerações e
 * exclusões do mesmo processo são serializadas.
 */

type ItemRow = Prisma.ProcessItemGetPayload<object>;

function toItem(row: ItemRow): ProcessItem {
  return {
    id: row.id,
    tenantId: row.tenantId,
    processId: row.processId,
    sequence: row.sequence,
    lotNumber: row.lotNumber,
    lotName: row.lotName,
    kind: row.kind,
    description: row.description,
    unitOfMeasureId: row.unitOfMeasureId,
    catalogSystem: row.catalogSystem,
    catalogCode: row.catalogCode,
    notes: row.notes,
    referenceQuantity: row.referenceQuantity?.toFixed(4) ?? null,
    referenceQuantitySourceDocumentId: row.referenceQuantitySourceDocumentId,
    referenceUnitPrice: row.referenceUnitPrice?.toFixed(4) ?? null,
    referenceUnitPriceSourceDocumentId: row.referenceUnitPriceSourceDocumentId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdById: row.createdById,
    updatedById: row.updatedById,
    version: row.version,
  };
}

@Injectable()
export class PrismaProcessItemRepository implements ProcessItemRepository {
  async listActive(tx: TenantTx, processId: string): Promise<ProcessItem[]> {
    const rows = await tx.processItem.findMany({
      where: { processId, deletedAt: null },
      orderBy: { sequence: 'asc' },
    });
    return rows.map(toItem);
  }

  async processOf(tx: TenantTx, itemId: string): Promise<string | null> {
    const row = await tx.processItem.findFirst({
      where: { id: itemId, deletedAt: null },
      select: { processId: true },
    });
    return row?.processId ?? null;
  }

  async lockItem(tx: TenantTx, itemId: string): Promise<ProcessItem | null> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT i.id
        FROM process_items i
       WHERE i.tenant_id = current_setting('app.tenant_id')::uuid
         AND i.id = ${itemId}::uuid
         AND i.deleted_at IS NULL
         FOR UPDATE`;
    if (locked.length === 0) return null;
    const row = await tx.processItem.findFirst({ where: { id: itemId } });
    return row === null ? null : toItem(row);
  }

  async lockForShare(
    tx: TenantTx,
    processId: string,
    itemIds: readonly string[],
  ): Promise<ProcessItem[]> {
    if (itemIds.length === 0) return [];
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT i.id
        FROM process_items i
       WHERE i.tenant_id = current_setting('app.tenant_id')::uuid
         AND i.process_id = ${processId}::uuid
         AND i.id = ANY(${[...itemIds]}::uuid[])
         AND i.deleted_at IS NULL
         FOR SHARE`;
    if (locked.length === 0) return [];
    const rows = await tx.processItem.findMany({
      where: { id: { in: locked.map((row) => row.id) } },
      orderBy: { sequence: 'asc' },
    });
    return rows.map(toItem);
  }

  async insert(tx: TenantTx, item: ProcessItem): Promise<void> {
    await tx.processItem.create({
      data: {
        id: item.id,
        tenantId: item.tenantId,
        processId: item.processId,
        sequence: item.sequence,
        lotNumber: item.lotNumber,
        lotName: item.lotName,
        kind: item.kind,
        description: item.description,
        unitOfMeasureId: item.unitOfMeasureId,
        catalogSystem: item.catalogSystem,
        catalogCode: item.catalogCode,
        notes: item.notes,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        createdById: item.createdById,
        updatedById: item.updatedById,
        version: item.version,
      },
      select: { id: true },
    });
  }

  async update(tx: TenantTx, items: readonly ProcessItem[]): Promise<void> {
    for (const item of items) {
      await tx.processItem.updateMany({
        where: { id: item.id, deletedAt: null },
        data: {
          lotNumber: item.lotNumber,
          lotName: item.lotName,
          kind: item.kind,
          description: item.description,
          unitOfMeasureId: item.unitOfMeasureId,
          catalogSystem: item.catalogSystem,
          catalogCode: item.catalogCode,
          notes: item.notes,
          updatedAt: item.updatedAt,
          updatedById: item.updatedById,
          version: item.version,
        },
      });
    }
  }

  async softDelete(tx: TenantTx, item: ProcessItem, at: Date, userId: string): Promise<void> {
    await tx.processItem.updateMany({
      where: { id: item.id, deletedAt: null },
      data: {
        deletedAt: at,
        deletedById: userId,
        updatedAt: at,
        updatedById: userId,
        version: { increment: 1 },
      },
    });
  }

  async resequence(
    tx: TenantTx,
    changes: readonly { readonly id: string; readonly to: number }[],
    at: Date,
    userId: string,
  ): Promise<void> {
    if (changes.length === 0) return;
    const ids = changes.map((change) => change.id);
    const targets = changes.map((change) => change.to);
    // Fase 1: números temporários negativos (fora de qualquer número definitivo).
    await tx.$executeRaw`
      UPDATE process_items i
         SET sequence = -c.target
        FROM unnest(${ids}::uuid[], ${targets}::int[]) AS c(id, target)
       WHERE i.tenant_id = current_setting('app.tenant_id')::uuid
         AND i.id = c.id AND i.deleted_at IS NULL`;
    // Fase 2: definitivos, com a nova versão e a autoria.
    await tx.$executeRaw`
      UPDATE process_items i
         SET sequence = -i.sequence, version = i.version + 1,
             updated_at = ${at}, updated_by_id = ${userId}::uuid
       WHERE i.tenant_id = current_setting('app.tenant_id')::uuid
         AND i.id = ANY(${ids}::uuid[]) AND i.deleted_at IS NULL`;
  }

  async stats(tx: TenantTx, processId: string): Promise<ProcessItemStats> {
    const [row] = await tx.$queryRaw<{ count: number; has_lots: boolean }[]>`
      SELECT count(*)::int AS count, coalesce(bool_or(i.lot_number IS NOT NULL), false) AS has_lots
        FROM process_items i
       WHERE i.tenant_id = current_setting('app.tenant_id')::uuid
         AND i.process_id = ${processId}::uuid
         AND i.deleted_at IS NULL`;
    return { count: row?.count ?? 0, hasLots: row?.has_lots ?? false };
  }

  async updateReferenceUnitPrices(
    tx: TenantTx,
    processId: string,
    input: {
      readonly lines: readonly { readonly itemId: string; readonly unitPrice: string }[];
      readonly sourceDocumentId: string;
      readonly at: Date;
      readonly userId: string;
    },
  ): Promise<number> {
    if (input.lines.length === 0) return 0;
    const ids = input.lines.map((line) => line.itemId);
    const prices = input.lines.map((line) => line.unitPrice);
    // Uma instrução para todos os itens (pesquisa com até 500 itens — p95 da conclusão).
    return tx.$executeRaw`
      UPDATE process_items i
         SET reference_unit_price = c.price::numeric,
             reference_unit_price_source_document_id = ${input.sourceDocumentId}::uuid,
             updated_at = ${input.at}, updated_by_id = ${input.userId}::uuid
        FROM unnest(${ids}::uuid[], ${prices}::text[]) AS c(id, price)
       WHERE i.tenant_id = current_setting('app.tenant_id')::uuid
         AND i.process_id = ${processId}::uuid
         AND i.id = c.id AND i.deleted_at IS NULL`;
  }

  async updateReferenceQuantities(
    tx: TenantTx,
    processId: string,
    input: {
      readonly lines: readonly { readonly itemId: string; readonly quantity: string }[];
      readonly sourceDocumentId: string;
      readonly at: Date;
      readonly userId: string;
    },
  ): Promise<number> {
    if (input.lines.length === 0) return 0;
    const ids = input.lines.map((line) => line.itemId);
    const quantities = input.lines.map((line) => line.quantity);
    return tx.$executeRaw`
      UPDATE process_items i
         SET reference_quantity = c.quantity::numeric,
             reference_quantity_source_document_id = ${input.sourceDocumentId}::uuid,
             updated_at = ${input.at}, updated_by_id = ${input.userId}::uuid
        FROM unnest(${ids}::uuid[], ${quantities}::text[]) AS c(id, quantity)
       WHERE i.tenant_id = current_setting('app.tenant_id')::uuid
         AND i.process_id = ${processId}::uuid
         AND i.id = c.id AND i.deleted_at IS NULL`;
  }
}

interface StoredItem extends ProcessItem {
  readonly deletedAt: Date | null;
  readonly deletedById: string | null;
}

function tenantOfContext(): string {
  return requireRequestContext().tenantId ?? '';
}

/**
 * Itens em memória (testes e modo fake), com a unicidade de `sequence` entre os não excluídos do
 * processo (como o índice único parcial). Atomicidade, RLS e travas reais são cobertas contra o
 * PostgreSQL em `test/tenant-leak/process-items.spec.ts`.
 */
@Injectable()
export class InMemoryProcessItemRepository implements ProcessItemRepository {
  private readonly items = new Map<string, StoredItem>();

  /** Carga de teste: os valores de referência que só os documentos e a pesquisa gravam (DEC-019). */
  setReferences(
    itemId: string,
    values: Partial<
      Pick<
        ProcessItem,
        | 'referenceQuantity'
        | 'referenceQuantitySourceDocumentId'
        | 'referenceUnitPrice'
        | 'referenceUnitPriceSourceDocumentId'
      >
    >,
  ): void {
    const item = this.items.get(itemId);
    if (item) this.items.set(itemId, { ...item, ...values });
  }

  /** Carga de teste direta (sem contexto de requisição): item ativo já validado. */
  seed(item: ProcessItem): void {
    this.items.set(item.id, { ...item, deletedAt: null, deletedById: null });
  }

  /** Todos os itens (inclusive excluídos) — inspeção dos testes. */
  all(): readonly StoredItem[] {
    return [...this.items.values()];
  }

  private active(processId: string): StoredItem[] {
    const tenantId = tenantOfContext();
    return [...this.items.values()]
      .filter(
        (item) =>
          item.tenantId === tenantId && item.processId === processId && item.deletedAt === null,
      )
      .sort((a, b) => a.sequence - b.sequence);
  }

  private owned(itemId: string): StoredItem | null {
    const item = this.items.get(itemId);
    return item?.tenantId === tenantOfContext() && item.deletedAt === null ? item : null;
  }

  private assertUniqueSequence(item: ProcessItem): void {
    const clash = this.active(item.processId).some(
      (other) => other.id !== item.id && other.sequence === item.sequence,
    );
    if (clash) throw new Error('process_items_sequence_key: número repetido no processo');
  }

  listActive(_tx: TenantTx, processId: string): Promise<ProcessItem[]> {
    return Promise.resolve(this.active(processId).map(strip));
  }

  processOf(_tx: TenantTx, itemId: string): Promise<string | null> {
    return Promise.resolve(this.owned(itemId)?.processId ?? null);
  }

  lockItem(_tx: TenantTx, itemId: string): Promise<ProcessItem | null> {
    const item = this.owned(itemId);
    return Promise.resolve(item === null ? null : strip(item));
  }

  lockForShare(
    _tx: TenantTx,
    processId: string,
    itemIds: readonly string[],
  ): Promise<ProcessItem[]> {
    const wanted = new Set(itemIds);
    return Promise.resolve(
      this.active(processId)
        .filter((item) => wanted.has(item.id))
        .map(strip),
    );
  }

  insert(_tx: TenantTx, item: ProcessItem): Promise<void> {
    this.assertUniqueSequence(item);
    this.items.set(item.id, { ...item, deletedAt: null, deletedById: null });
    return Promise.resolve();
  }

  update(_tx: TenantTx, items: readonly ProcessItem[]): Promise<void> {
    for (const item of items) {
      const current = this.owned(item.id);
      if (current) this.items.set(item.id, { ...current, ...item, sequence: current.sequence });
    }
    return Promise.resolve();
  }

  softDelete(_tx: TenantTx, item: ProcessItem, at: Date, userId: string): Promise<void> {
    const current = this.owned(item.id);
    if (current) {
      this.items.set(item.id, {
        ...current,
        deletedAt: at,
        deletedById: userId,
        updatedAt: at,
        updatedById: userId,
        version: current.version + 1,
      });
    }
    return Promise.resolve();
  }

  resequence(
    _tx: TenantTx,
    changes: readonly { readonly id: string; readonly to: number }[],
    at: Date,
    userId: string,
  ): Promise<void> {
    for (const change of changes) {
      const current = this.owned(change.id);
      if (current) {
        this.items.set(change.id, {
          ...current,
          sequence: change.to,
          version: current.version + 1,
          updatedAt: at,
          updatedById: userId,
        });
      }
    }
    const first = changes[0] && this.items.get(changes[0].id);
    if (first) {
      const sequences = this.active(first.processId).map((item) => item.sequence);
      if (new Set(sequences).size !== sequences.length) {
        throw new Error('process_items_sequence_key: número repetido no processo');
      }
    }
    return Promise.resolve();
  }

  stats(_tx: TenantTx, processId: string): Promise<ProcessItemStats> {
    const active = this.active(processId);
    return Promise.resolve({
      count: active.length,
      hasLots: active.some((item) => item.lotNumber !== null),
    });
  }

  updateReferenceUnitPrices(
    _tx: TenantTx,
    processId: string,
    input: {
      readonly lines: readonly { readonly itemId: string; readonly unitPrice: string }[];
      readonly sourceDocumentId: string;
      readonly at: Date;
      readonly userId: string;
    },
  ): Promise<number> {
    const active = new Map(this.active(processId).map((item) => [item.id, item]));
    let updated = 0;
    for (const line of input.lines) {
      const current = active.get(line.itemId);
      if (current === undefined) continue;
      this.items.set(line.itemId, {
        ...current,
        referenceUnitPrice: new Decimal(line.unitPrice).toFixed(4),
        referenceUnitPriceSourceDocumentId: input.sourceDocumentId,
        updatedAt: input.at,
        updatedById: input.userId,
      });
      updated += 1;
    }
    return Promise.resolve(updated);
  }

  updateReferenceQuantities(
    _tx: TenantTx,
    processId: string,
    input: {
      readonly lines: readonly { readonly itemId: string; readonly quantity: string }[];
      readonly sourceDocumentId: string;
      readonly at: Date;
      readonly userId: string;
    },
  ): Promise<number> {
    const active = new Map(this.active(processId).map((item) => [item.id, item]));
    let updated = 0;
    for (const line of input.lines) {
      const current = active.get(line.itemId);
      if (current === undefined) continue;
      this.items.set(line.itemId, {
        ...current,
        referenceQuantity: new Decimal(line.quantity).toFixed(4),
        referenceQuantitySourceDocumentId: input.sourceDocumentId,
        updatedAt: input.at,
        updatedById: input.userId,
      });
      updated += 1;
    }
    return Promise.resolve(updated);
  }
}

function strip(item: StoredItem): ProcessItem {
  const { deletedAt: _deletedAt, deletedById: _deletedById, ...rest } = item;
  return rest;
}
