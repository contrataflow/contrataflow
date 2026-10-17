import type { SupplierDocumentType } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import { TenantTransaction } from '#shared/database/database.module.js';
import { isUniqueViolation } from '#shared/database/errors.js';
import { updateVersioned } from '#shared/database/optimistic-concurrency.js';
import type { Prisma, TenantTx } from '#shared/database/prisma.js';

import { SupplierDocumentTakenError } from '../application/supplier-ports.js';
import type {
  SupplierListFilter,
  SupplierRepository,
  SupplierTransactions,
} from '../application/supplier-ports.js';
import type { Supplier } from '../domain/supplier.js';

type Row = Prisma.SupplierGetPayload<object>;

function toDomain(row: Row): Supplier {
  return {
    id: row.id,
    tenantId: row.tenantId,
    documentType: row.documentType,
    documentNumber: row.documentNumber,
    documentNumberEncrypted:
      row.documentNumberEncrypted === null ? null : Buffer.from(row.documentNumberEncrypted),
    documentNumberHash: row.documentNumberHash,
    legalName: row.legalName,
    tradeName: row.tradeName,
    email: row.email,
    phone: row.phone,
    website: row.website,
    contactName: row.contactName,
    addressStreet: row.addressStreet,
    addressNumber: row.addressNumber,
    addressComplement: row.addressComplement,
    addressDistrict: row.addressDistrict,
    addressCity: row.addressCity,
    addressState: row.addressState,
    addressZipCode: row.addressZipCode,
    isActive: row.isActive,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdById: row.createdById,
    updatedById: row.updatedById,
    deletedAt: row.deletedAt,
    version: row.version,
  };
}

/** Busca textual: razão social, nome fantasia ou documento (contém, sem diferenciar maiúsculas). */
function searchWhere(q: string | undefined): Prisma.SupplierWhereInput {
  const needle = q?.trim();
  if (!needle) return {};
  return {
    OR: [
      { legalName: { contains: needle, mode: 'insensitive' } },
      { tradeName: { contains: needle, mode: 'insensitive' } },
      { documentNumber: { contains: needle, mode: 'insensitive' } },
    ],
  };
}

/**
 * `suppliers` no PostgreSQL (US-025): leituras e escritas no `tx` do caso de uso, sob a RLS do
 * tenant e a extensão de isolamento (que injeta o `tenantId`). O documento (tipo, número, cifra e
 * hash) só é gravado na inserção — a edição nunca o reescreve (e o gatilho da migração o impede).
 */
@Injectable()
export class PrismaSupplierRepository implements SupplierRepository {
  async list(
    tx: TenantTx,
    filter: SupplierListFilter,
    window: { readonly skip: number; readonly take: number },
  ): Promise<{ items: Supplier[]; total: number }> {
    const where: Prisma.SupplierWhereInput = {
      deletedAt: null,
      ...(filter.isActive === undefined ? {} : { isActive: filter.isActive }),
      ...searchWhere(filter.q),
    };
    const [rows, total] = await Promise.all([
      tx.supplier.findMany({
        where,
        orderBy: [{ legalName: 'asc' }, { id: 'asc' }],
        skip: window.skip,
        take: window.take,
      }),
      tx.supplier.count({ where }),
    ]);
    return { items: rows.map(toDomain), total };
  }

  async findById(tx: TenantTx, id: string): Promise<Supplier | null> {
    const row = await tx.supplier.findFirst({ where: { id, deletedAt: null } });
    return row === null ? null : toDomain(row);
  }

  async findByDocumentHashes(tx: TenantTx, hashes: readonly string[]): Promise<Supplier[]> {
    if (hashes.length === 0) return [];
    const rows = await tx.supplier.findMany({
      where: { documentNumberHash: { in: [...hashes] }, deletedAt: null },
    });
    return rows.map(toDomain);
  }

  async findByDocument(
    tx: TenantTx,
    documentType: SupplierDocumentType,
    hash: string,
  ): Promise<Supplier | null> {
    const row = await tx.supplier.findFirst({
      where: { documentType, documentNumberHash: hash, deletedAt: null },
    });
    return row === null ? null : toDomain(row);
  }

  async insert(tx: TenantTx, supplier: Supplier): Promise<void> {
    try {
      await tx.supplier.create({
        data: {
          id: supplier.id,
          tenantId: supplier.tenantId,
          documentType: supplier.documentType,
          documentNumber: supplier.documentNumber,
          documentNumberEncrypted:
            supplier.documentNumberEncrypted === null
              ? null
              : new Uint8Array(supplier.documentNumberEncrypted),
          documentNumberHash: supplier.documentNumberHash,
          legalName: supplier.legalName,
          tradeName: supplier.tradeName,
          email: supplier.email,
          phone: supplier.phone,
          website: supplier.website,
          contactName: supplier.contactName,
          addressStreet: supplier.addressStreet,
          addressNumber: supplier.addressNumber,
          addressComplement: supplier.addressComplement,
          addressDistrict: supplier.addressDistrict,
          addressCity: supplier.addressCity,
          addressState: supplier.addressState,
          addressZipCode: supplier.addressZipCode,
          isActive: supplier.isActive,
          notes: supplier.notes,
          createdAt: supplier.createdAt,
          updatedAt: supplier.updatedAt,
          createdById: supplier.createdById,
          updatedById: supplier.updatedById,
          version: supplier.version,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new SupplierDocumentTakenError();
      throw error;
    }
  }

  async update(tx: TenantTx, supplier: Supplier, expectedVersion: number): Promise<void> {
    await updateVersioned(
      { aggregateType: 'Supplier', aggregateId: supplier.id, expectedVersion },
      () =>
        tx.supplier.updateMany({
          where: { id: supplier.id, version: expectedVersion, deletedAt: null },
          data: {
            legalName: supplier.legalName,
            tradeName: supplier.tradeName,
            email: supplier.email,
            phone: supplier.phone,
            website: supplier.website,
            contactName: supplier.contactName,
            addressStreet: supplier.addressStreet,
            addressNumber: supplier.addressNumber,
            addressComplement: supplier.addressComplement,
            addressDistrict: supplier.addressDistrict,
            addressCity: supplier.addressCity,
            addressState: supplier.addressState,
            addressZipCode: supplier.addressZipCode,
            isActive: supplier.isActive,
            notes: supplier.notes,
            updatedAt: supplier.updatedAt,
            updatedById: supplier.updatedById,
            version: { increment: 1 },
          },
        }),
    );
  }

  async softDelete(
    tx: TenantTx,
    supplier: Supplier,
    expectedVersion: number,
    deletion: { readonly at: Date; readonly userId: string | null },
  ): Promise<void> {
    await updateVersioned(
      { aggregateType: 'Supplier', aggregateId: supplier.id, expectedVersion },
      () =>
        tx.supplier.updateMany({
          where: { id: supplier.id, version: expectedVersion, deletedAt: null },
          data: {
            deletedAt: deletion.at,
            updatedAt: deletion.at,
            updatedById: deletion.userId,
            version: { increment: 1 },
          },
        }),
    );
  }
}

/** Transações do módulo sobre a `TenantTransaction` (contexto de tenant da requisição). */
@Injectable()
export class PrismaSupplierTransactions implements SupplierTransactions {
  constructor(private readonly transaction: TenantTransaction) {}

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.run(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.read(work);
  }
}
