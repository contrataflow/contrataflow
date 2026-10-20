import { Injectable } from '@nestjs/common';

import { isUniqueViolation } from '#shared/database/errors.js';
import type { Prisma, TenantTx } from '#shared/database/prisma.js';

import { DuplicateRenditionError } from '../application/rendition.ports.js';
import type {
  DocumentRenditionRepository,
  EquivalentRenditionKey,
} from '../application/rendition.ports.js';
import type { DocumentRendition } from '../domain/document-rendition.js';

type Row = Prisma.DocumentRenditionGetPayload<object>;

function toDomain(row: Row): DocumentRendition {
  return {
    id: row.id,
    tenantId: row.tenantId,
    processId: row.processId,
    documentId: row.documentId,
    documentVersionId: row.documentVersionId,
    draftRevision: row.draftRevision,
    approvalId: row.approvalId,
    kind: row.kind,
    status: row.status,
    masked: row.masked,
    storageKey: row.storageKey,
    sha256: row.sha256,
    sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
    pageCount: row.pageCount,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    attempts: row.attempts,
    requestedById: row.requestedById,
    requestedAt: row.requestedAt,
    startedAt: row.startedAt,
    readyAt: row.readyAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

/**
 * `document_renditions` no PostgreSQL (US-067): leituras e escritas no `tx` do caso de uso (ou do
 * job), sob a RLS do tenant e a extensão de isolamento. Toda mudança de estado é condicional à
 * versão lida; o gatilho `document_renditions_guard` repete a máquina de estados e a escrita única
 * do PDF pronto. Os índices únicos parciais decidem a corrida de dois pedidos equivalentes (FA-01).
 */
@Injectable()
export class PrismaDocumentRenditionRepository implements DocumentRenditionRepository {
  async insert(tx: TenantTx, rendition: DocumentRendition): Promise<void> {
    try {
      await tx.documentRendition.create({
        data: {
          id: rendition.id,
          tenantId: rendition.tenantId,
          processId: rendition.processId,
          documentId: rendition.documentId,
          documentVersionId: rendition.documentVersionId,
          draftRevision: rendition.draftRevision,
          approvalId: rendition.approvalId,
          kind: rendition.kind,
          status: rendition.status,
          masked: rendition.masked,
          attempts: rendition.attempts,
          requestedById: rendition.requestedById,
          requestedAt: rendition.requestedAt,
          expiresAt: rendition.expiresAt,
          createdAt: rendition.createdAt,
          updatedAt: rendition.updatedAt,
          version: rendition.version,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicateRenditionError();
      throw error;
    }
  }

  async findById(tx: TenantTx, id: string): Promise<DocumentRendition | null> {
    const row = await tx.documentRendition.findFirst({ where: { id } });
    return row === null ? null : toDomain(row);
  }

  async findEquivalent(
    tx: TenantTx,
    key: EquivalentRenditionKey,
  ): Promise<DocumentRendition | null> {
    const row = await tx.documentRendition.findFirst({
      where: {
        documentVersionId: key.documentVersionId,
        kind: key.kind,
        approvalId: key.approvalId,
        masked: key.masked,
        status: { in: ['PENDING', 'PROCESSING', 'READY'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    return row === null ? null : toDomain(row);
  }

  async update(tx: TenantTx, next: DocumentRendition, expectedVersion: number): Promise<boolean> {
    const { count } = await tx.documentRendition.updateMany({
      where: { id: next.id, version: expectedVersion },
      data: {
        status: next.status,
        storageKey: next.storageKey,
        sha256: next.sha256,
        sizeBytes: next.sizeBytes === null ? null : BigInt(next.sizeBytes),
        pageCount: next.pageCount,
        errorCode: next.errorCode,
        errorMessage: next.errorMessage,
        attempts: next.attempts,
        startedAt: next.startedAt,
        readyAt: next.readyAt,
        expiresAt: next.expiresAt,
        updatedAt: next.updatedAt,
        version: next.version,
      },
    });
    return count === 1;
  }
}
