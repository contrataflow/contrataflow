import { approvalPolicySchema } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import { TenantTransaction } from '#shared/database/database.module.js';
import { isUniqueViolation } from '#shared/database/errors.js';
import { updateVersioned } from '#shared/database/optimistic-concurrency.js';
import { Prisma } from '#shared/database/prisma.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { DocumentTypeCodeTakenError } from '../application/ports.js';
import type { DocumentTransactions, DocumentTypeRepository } from '../application/ports.js';
import type { DocumentType } from '../domain/document-type.js';

type Row = Prisma.DocumentTypeGetPayload<object>;

/** Linha → domínio. A política é conferida pelo schema; linha corrompida vira erro explícito. */
function toDomain(row: Row): DocumentType {
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    name: row.name,
    description: row.description,
    kind: row.kind,
    systemModule: row.systemModule,
    isSystem: row.isSystem,
    isActive: row.isActive,
    allowMultiplePerProcess: row.allowMultiplePerProcess,
    numberingEnabled: row.numberingEnabled,
    numberingMask: row.numberingMask,
    requiresApproval: row.requiresApproval,
    approvalPolicy:
      row.approvalPolicy === null ? null : approvalPolicySchema.parse(row.approvalPolicy),
    defaultTemplateId: row.defaultTemplateId,
    defaultConfidentiality: row.defaultConfidentiality,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdById: row.createdById,
    updatedById: row.updatedById,
    version: row.version,
  };
}

function toCreateData(type: DocumentType): Prisma.DocumentTypeUncheckedCreateInput {
  return {
    id: type.id,
    tenantId: type.tenantId,
    code: type.code,
    name: type.name,
    description: type.description,
    kind: type.kind,
    systemModule: type.systemModule,
    isSystem: type.isSystem,
    isActive: type.isActive,
    allowMultiplePerProcess: type.allowMultiplePerProcess,
    numberingEnabled: type.numberingEnabled,
    numberingMask: type.numberingMask,
    requiresApproval: type.requiresApproval,
    ...(type.approvalPolicy ? { approvalPolicy: type.approvalPolicy } : {}),
    defaultTemplateId: type.defaultTemplateId,
    defaultConfidentiality: type.defaultConfidentiality,
    sortOrder: type.sortOrder,
    createdAt: type.createdAt,
    updatedAt: type.updatedAt,
    createdById: type.createdById,
    updatedById: type.updatedById,
    version: type.version,
  };
}

/**
 * `document_types` no PostgreSQL (US-061): leituras e escritas no `tx` do caso de uso, sob a RLS
 * do tenant e a extensão de isolamento (que injeta o `tenantId`). Nenhuma exclusão (RN-DOC-11).
 */
@Injectable()
export class PrismaDocumentTypeRepository implements DocumentTypeRepository {
  async list(tx: TenantTx): Promise<DocumentType[]> {
    const rows = await tx.documentType.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return rows.map(toDomain);
  }

  async findById(tx: TenantTx, id: string): Promise<DocumentType | null> {
    const row = await tx.documentType.findFirst({ where: { id } });
    return row === null ? null : toDomain(row);
  }

  async findByCode(tx: TenantTx, code: string): Promise<DocumentType | null> {
    const row = await tx.documentType.findFirst({ where: { code } });
    return row === null ? null : toDomain(row);
  }

  async insert(tx: TenantTx, type: DocumentType): Promise<void> {
    try {
      await tx.documentType.create({ data: toCreateData(type) });
    } catch (error) {
      // Corrida de duas criações do mesmo código: o índice único decide (V-05).
      if (isUniqueViolation(error)) throw new DocumentTypeCodeTakenError(type.code);
      throw error;
    }
  }

  async update(tx: TenantTx, type: DocumentType, expectedVersion: number): Promise<void> {
    await updateVersioned(
      { aggregateType: 'DocumentType', aggregateId: type.id, expectedVersion },
      () =>
        tx.documentType.updateMany({
          where: { id: type.id, version: expectedVersion },
          data: {
            name: type.name,
            description: type.description,
            allowMultiplePerProcess: type.allowMultiplePerProcess,
            numberingEnabled: type.numberingEnabled,
            numberingMask: type.numberingMask,
            requiresApproval: type.requiresApproval,
            approvalPolicy: type.approvalPolicy ?? Prisma.DbNull,
            defaultConfidentiality: type.defaultConfidentiality,
            defaultTemplateId: type.defaultTemplateId,
            sortOrder: type.sortOrder,
            isActive: type.isActive,
            updatedAt: type.updatedAt,
            updatedById: type.updatedById,
            version: { increment: 1 },
          },
        }),
    );
  }

  async insertMissing(tx: TenantTx, types: readonly DocumentType[]): Promise<number> {
    if (types.length === 0) return 0;
    const result = await tx.documentType.createMany({
      data: types.map(toCreateData),
      skipDuplicates: true,
    });
    return result.count;
  }
}

/** Transações do módulo sobre a `TenantTransaction` (contexto de tenant da requisição). */
@Injectable()
export class PrismaDocumentTransactions implements DocumentTransactions {
  constructor(private readonly transaction: TenantTransaction) {}

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.run(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.read(work);
  }
}
