import { documentSnapshotSchema, draftContentSchema } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import { isUniqueViolation } from '#shared/database/errors.js';
import { updateVersioned } from '#shared/database/optimistic-concurrency.js';
import type { Prisma, TenantTx } from '#shared/database/prisma.js';

import { DocumentAlreadyExistsError } from '../application/document.ports.js';
import type { DocumentLabel, DocumentRepository } from '../application/document.ports.js';
import type { DocumentVersionRecord } from '../domain/document-snapshot.js';
import type { Document } from '../domain/document.js';

type DocumentRow = Prisma.DocumentGetPayload<object>;
type VersionRow = Prisma.DocumentVersionGetPayload<object>;

/** Texto da cadeia do erro (mensagem, restrição) para saber QUAL índice único foi violado. */
function textOf(error: unknown): string {
  const parts: string[] = [];
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    for (const key of ['message', 'originalMessage', 'constraint', 'detail']) {
      if (typeof record[key] === 'string') parts.push(record[key]);
    }
    if (record.target !== undefined) parts.push(JSON.stringify(record.target));
    if (record.constraint !== undefined) parts.push(JSON.stringify(record.constraint));
    pending.push(record.cause, record.meta, record.driverAdapterError);
  }
  return parts.join(' | ');
}

/** Linha → domínio. O JSONB do rascunho é conferido pelo schema; linha corrompida vira erro. */
function toDocument(row: DocumentRow, currentVersionNumber: number | null): Document {
  return {
    id: row.id,
    tenantId: row.tenantId,
    processId: row.processId,
    documentTypeId: row.documentTypeId,
    templateVersionId: row.templateVersionId,
    number: row.number,
    year: row.year,
    code: row.code,
    title: row.title,
    status: row.status,
    confidentiality: row.confidentiality,
    draftContent: draftContentSchema.parse(row.draftContent),
    draftRevision: row.draftRevision,
    singletonKey: row.singletonKey,
    currentVersionId: row.currentVersionId,
    currentVersionNumber,
    approvedVersionId: row.approvedVersionId,
    pendingApprovalId: row.pendingApprovalId,
    responsibleId: row.responsibleId,
    submittedAt: row.submittedAt,
    submittedById: row.submittedById,
    finalizedAt: row.finalizedAt,
    finalizedById: row.finalizedById,
    approvedAt: row.approvedAt,
    returnedAt: row.returnedAt,
    rejectedAt: row.rejectedAt,
    reopenedAt: row.reopenedAt,
    reopenedById: row.reopenedById,
    reopenReason: row.reopenReason,
    canceledAt: row.canceledAt,
    canceledById: row.canceledById,
    cancellationReason: row.cancellationReason,
    sourceDocumentId: row.sourceDocumentId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdById: row.createdById,
    updatedById: row.updatedById,
    deletedAt: row.deletedAt,
    version: row.version,
  };
}

function toVersion(row: VersionRow): DocumentVersionRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    documentId: row.documentId,
    processId: row.processId,
    versionNumber: row.versionNumber,
    reason: row.reason,
    statusAtCreation: row.statusAtCreation,
    content: row.content === null ? null : documentSnapshotSchema.parse(row.content),
    contentHash: row.contentHash,
    attachmentId: row.attachmentId,
    templateVersionId: row.templateVersionId,
    changeSummary: row.changeSummary,
    createdById: row.createdById,
    createdAt: row.createdAt,
  };
}

const json = (value: unknown) => value as Prisma.InputJsonValue;

/** Colunas mutáveis do documento (tudo menos identidade, tenant, processo, tipo e criação). */
function mutableColumns(document: Document) {
  return {
    templateVersionId: document.templateVersionId,
    number: document.number,
    year: document.year,
    code: document.code,
    title: document.title,
    status: document.status,
    confidentiality: document.confidentiality,
    draftContent: json(document.draftContent),
    draftRevision: document.draftRevision,
    singletonKey: document.singletonKey,
    currentVersionId: document.currentVersionId,
    approvedVersionId: document.approvedVersionId,
    pendingApprovalId: document.pendingApprovalId,
    responsibleId: document.responsibleId,
    submittedAt: document.submittedAt,
    submittedById: document.submittedById,
    finalizedAt: document.finalizedAt,
    finalizedById: document.finalizedById,
    approvedAt: document.approvedAt,
    returnedAt: document.returnedAt,
    rejectedAt: document.rejectedAt,
    reopenedAt: document.reopenedAt,
    reopenedById: document.reopenedById,
    reopenReason: document.reopenReason,
    canceledAt: document.canceledAt,
    canceledById: document.canceledById,
    cancellationReason: document.cancellationReason,
    sourceDocumentId: document.sourceDocumentId,
    updatedAt: document.updatedAt,
    updatedById: document.updatedById,
    deletedAt: document.deletedAt,
  };
}

/**
 * `documents` e `document_versions` no PostgreSQL (US-065): leituras e escritas no `tx` do caso de
 * uso, sob a RLS do tenant e a extensão de isolamento (que injeta o `tenantId`). Versões só com
 * INSERT (gatilho `document_versions_append_only`); documento só com exclusão lógica.
 */
@Injectable()
export class PrismaDocumentRepository implements DocumentRepository {
  private async versionNumberOf(tx: TenantTx, versionId: string | null): Promise<number | null> {
    if (versionId === null) return null;
    const row = await tx.documentVersion.findFirst({
      where: { id: versionId },
      select: { versionNumber: true },
    });
    return row?.versionNumber ?? null;
  }

  async findById(tx: TenantTx, id: string): Promise<Document | null> {
    const row = await tx.document.findFirst({ where: { id, deletedAt: null } });
    if (row === null) return null;
    return toDocument(row, await this.versionNumberOf(tx, row.currentVersionId));
  }

  async findActiveOfType(
    tx: TenantTx,
    processId: string,
    documentTypeId: string,
  ): Promise<Document | null> {
    const row = await tx.document.findFirst({
      where: { processId, documentTypeId, deletedAt: null, status: { not: 'CANCELED' } },
      orderBy: { createdAt: 'asc' },
    });
    if (row === null) return null;
    return toDocument(row, await this.versionNumberOf(tx, row.currentVersionId));
  }

  listActiveByProcess(tx: TenantTx, processId: string): Promise<Document[]> {
    return this.listWhere(tx, { processId, deletedAt: null, status: { not: 'CANCELED' } });
  }

  listByProcess(tx: TenantTx, processId: string): Promise<Document[]> {
    return this.listWhere(tx, { processId, deletedAt: null });
  }

  private async listWhere(tx: TenantTx, where: Prisma.DocumentWhereInput): Promise<Document[]> {
    const rows = await tx.document.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const versionIds = rows.flatMap((row) =>
      row.currentVersionId === null ? [] : [row.currentVersionId],
    );
    const numbers = await this.versionNumbers(tx, versionIds);
    return rows.map((row) =>
      toDocument(
        row,
        row.currentVersionId === null ? null : (numbers.get(row.currentVersionId) ?? null),
      ),
    );
  }

  async insert(tx: TenantTx, document: Document): Promise<void> {
    try {
      await tx.document.create({
        data: {
          id: document.id,
          tenantId: document.tenantId,
          processId: document.processId,
          documentTypeId: document.documentTypeId,
          ...mutableColumns(document),
          createdAt: document.createdAt,
          createdById: document.createdById,
          version: document.version,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error) && /singleton/i.test(textOf(error))) {
        throw new DocumentAlreadyExistsError(document.documentTypeId);
      }
      throw error;
    }
  }

  async update(tx: TenantTx, document: Document, expectedVersion: number): Promise<void> {
    try {
      await updateVersioned(
        { aggregateType: 'Document', aggregateId: document.id, expectedVersion },
        () =>
          tx.document.updateMany({
            where: { id: document.id, version: expectedVersion, deletedAt: null },
            data: { ...mutableColumns(document), version: { increment: 1 } },
          }),
      );
    } catch (error) {
      // Reabrir/restaurar um singular que outro documento ativo já ocupa (RN-DOC-50).
      if (isUniqueViolation(error) && /singleton/i.test(textOf(error))) {
        throw new DocumentAlreadyExistsError(document.documentTypeId);
      }
      throw error;
    }
  }

  async lockForUpdate(tx: TenantTx, documentId: string): Promise<void> {
    // A RLS limita ao tenant; a linha fica travada até o commit/rollback do caso de uso.
    await tx.$queryRaw`SELECT id FROM documents WHERE id = ${documentId}::uuid FOR UPDATE`;
  }

  async listVersions(
    tx: TenantTx,
    documentId: string,
    window: { readonly skip: number; readonly take: number },
  ): Promise<{ items: DocumentVersionRecord[]; total: number }> {
    const [rows, total] = await Promise.all([
      tx.documentVersion.findMany({
        where: { documentId },
        orderBy: { versionNumber: 'desc' },
        skip: window.skip,
        take: window.take,
      }),
      tx.documentVersion.count({ where: { documentId } }),
    ]);
    return { items: rows.map(toVersion), total };
  }

  async nextVersionNumber(tx: TenantTx, documentId: string): Promise<number> {
    const result = await tx.documentVersion.aggregate({
      where: { documentId },
      _max: { versionNumber: true },
    });
    return (result._max.versionNumber ?? 0) + 1;
  }

  async insertVersion(tx: TenantTx, version: DocumentVersionRecord): Promise<void> {
    await tx.documentVersion.create({
      data: {
        id: version.id,
        tenantId: version.tenantId,
        documentId: version.documentId,
        processId: version.processId,
        versionNumber: version.versionNumber,
        reason: version.reason,
        statusAtCreation: version.statusAtCreation,
        ...(version.content === null ? {} : { content: json(version.content) }),
        contentHash: version.contentHash,
        attachmentId: version.attachmentId,
        templateVersionId: version.templateVersionId,
        changeSummary: version.changeSummary,
        createdById: version.createdById,
        createdAt: version.createdAt,
      },
    });
  }

  async findVersion(tx: TenantTx, versionId: string): Promise<DocumentVersionRecord | null> {
    const row = await tx.documentVersion.findFirst({ where: { id: versionId } });
    return row === null ? null : toVersion(row);
  }

  countByType(tx: TenantTx, documentTypeId: string): Promise<number> {
    return tx.document.count({ where: { documentTypeId, deletedAt: null } });
  }

  async labels(tx: TenantTx, ids: readonly string[]): Promise<Map<string, DocumentLabel>> {
    if (ids.length === 0) return new Map();
    const rows = await tx.document.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, code: true, title: true, documentTypeId: true },
    });
    return new Map(
      rows.map((row) => [
        row.id,
        { code: row.code, title: row.title, documentTypeId: row.documentTypeId },
      ]),
    );
  }

  async versionNumbers(tx: TenantTx, versionIds: readonly string[]): Promise<Map<string, number>> {
    if (versionIds.length === 0) return new Map();
    const rows = await tx.documentVersion.findMany({
      where: { id: { in: [...versionIds] } },
      select: { id: true, versionNumber: true },
    });
    return new Map(rows.map((row) => [row.id, row.versionNumber]));
  }
}
