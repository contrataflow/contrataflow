import type { AttachmentReasonCode } from '@contrataflow/types';
import { Injectable } from '@nestjs/common';

import { TenantTransaction } from '#shared/database/database.module.js';
import type { Prisma, TenantTx } from '#shared/database/prisma.js';

import type { AttachmentRepository, FilesTransactions } from '../application/files-ports.js';
import type { Attachment, ScanResult } from '../domain/attachment.js';

type Row = Prisma.AttachmentGetPayload<object>;

function scanResultOf(value: Prisma.JsonValue | null): ScanResult | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const json = value as Record<string, unknown>;
  const claim = json.claim as { attempt?: unknown; at?: unknown } | undefined;
  return {
    ...(claim && typeof claim.attempt === 'number' && typeof claim.at === 'string'
      ? { claim: { attempt: claim.attempt, at: claim.at } }
      : {}),
    ...(typeof json.engine === 'string' ? { engine: json.engine } : {}),
    ...(typeof json.engineVersion === 'string' ? { engineVersion: json.engineVersion } : {}),
    ...(typeof json.signature === 'string' ? { signature: json.signature } : {}),
    ...(typeof json.reasonCode === 'string'
      ? { reasonCode: json.reasonCode as AttachmentReasonCode }
      : {}),
    ...(typeof json.detectedMimeType === 'string'
      ? { detectedMimeType: json.detectedMimeType }
      : {}),
    ...(typeof json.durationMs === 'number' ? { durationMs: json.durationMs } : {}),
  };
}

function toDomain(row: Row): Attachment {
  return {
    id: row.id,
    tenantId: row.tenantId,
    processId: row.processId,
    targetType: row.targetType,
    targetId: row.targetId,
    categoryId: row.categoryId,
    fileName: row.fileName,
    extension: row.extension,
    declaredMimeType: row.declaredMimeType,
    detectedMimeType: row.detectedMimeType,
    sizeBytes: Number(row.sizeBytes),
    sha256: row.sha256,
    storageKey: row.storageKey,
    quarantineKey: row.quarantineKey,
    status: row.status,
    scanResult: scanResultOf(row.scanResult),
    scannedAt: row.scannedAt,
    description: row.description,
    uploadedById: row.uploadedById,
    uploadedAt: row.uploadedAt,
    deletionReason: row.deletionReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    updatedById: row.updatedById,
    deletedAt: row.deletedAt,
    deletedById: row.deletedById,
    version: row.version,
    sourceAttachmentId: row.sourceAttachmentId,
  };
}

function scanResultJson(value: ScanResult | null): Prisma.InputJsonValue | undefined {
  return value === null ? undefined : (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue);
}

/**
 * `attachments` no PostgreSQL (US-068): leituras e escritas no `tx` do caso de uso, sob a RLS do
 * tenant e a extensão de isolamento (que injeta o `tenantId`). Toda mudança de estado é condicional
 * à versão lida (`UPDATE … WHERE version = $lida`); o gatilho `attachments_guard` repete a máquina
 * de estados e a imutabilidade de alvo, chave, tamanho e autor.
 */
@Injectable()
export class PrismaAttachmentRepository implements AttachmentRepository {
  async insert(tx: TenantTx, attachment: Attachment): Promise<void> {
    const scanResult = scanResultJson(attachment.scanResult);
    await tx.attachment.create({
      data: {
        id: attachment.id,
        tenantId: attachment.tenantId,
        processId: attachment.processId,
        targetType: attachment.targetType,
        targetId: attachment.targetId,
        categoryId: attachment.categoryId,
        fileName: attachment.fileName,
        extension: attachment.extension,
        declaredMimeType: attachment.declaredMimeType,
        detectedMimeType: attachment.detectedMimeType,
        sizeBytes: BigInt(attachment.sizeBytes),
        sha256: attachment.sha256,
        storageKey: attachment.storageKey,
        quarantineKey: attachment.quarantineKey,
        status: attachment.status,
        ...(scanResult === undefined ? {} : { scanResult }),
        scannedAt: attachment.scannedAt,
        description: attachment.description,
        uploadedById: attachment.uploadedById,
        uploadedAt: attachment.uploadedAt,
        sourceAttachmentId: attachment.sourceAttachmentId ?? null,
        createdAt: attachment.createdAt,
        updatedAt: attachment.updatedAt,
        createdById: attachment.uploadedById,
        updatedById: attachment.updatedById,
        version: attachment.version,
      },
    });
  }

  async findById(tx: TenantTx, id: string): Promise<Attachment | null> {
    const row = await tx.attachment.findFirst({ where: { id } });
    return row === null ? null : toDomain(row);
  }

  async findByIds(tx: TenantTx, ids: readonly string[]): Promise<Attachment[]> {
    if (ids.length === 0) return [];
    const rows = await tx.attachment.findMany({ where: { id: { in: [...ids] } } });
    return rows.map(toDomain);
  }

  async listAvailableByProcess(tx: TenantTx, processId: string): Promise<Attachment[]> {
    const rows = await tx.attachment.findMany({
      where: { processId, status: 'AVAILABLE', deletedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toDomain);
  }

  async update(tx: TenantTx, next: Attachment, expectedVersion: number): Promise<boolean> {
    const scanResult = scanResultJson(next.scanResult);
    const { count } = await tx.attachment.updateMany({
      where: { id: next.id, version: expectedVersion },
      data: {
        status: next.status,
        detectedMimeType: next.detectedMimeType,
        sha256: next.sha256,
        ...(scanResult === undefined ? {} : { scanResult }),
        scannedAt: next.scannedAt,
        uploadedAt: next.uploadedAt,
        deletionReason: next.deletionReason,
        deletedAt: next.deletedAt,
        deletedById: next.deletedById,
        updatedAt: next.updatedAt,
        updatedById: next.updatedById,
        version: next.version,
      },
    });
    return count === 1;
  }

  async usedBytes(tx: TenantTx): Promise<number> {
    const result = await tx.attachment.aggregate({
      where: { status: { in: ['UPLOADED', 'SCANNING', 'AVAILABLE', 'DELETED'] } },
      _sum: { sizeBytes: true },
    });
    return Number(result._sum.sizeBytes ?? 0n);
  }
}

/** Transações do módulo pela `TenantTransaction` (RLS do tenant do contexto). */
@Injectable()
export class PrismaFilesTransactions implements FilesTransactions {
  constructor(private readonly transaction: TenantTransaction) {}

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.run(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.read(work);
  }
}
