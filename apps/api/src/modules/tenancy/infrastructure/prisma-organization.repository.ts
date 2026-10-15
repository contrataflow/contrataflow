import { Injectable } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import { TenantTransaction } from '#shared/database/database.module.js';
import { isUniqueViolation } from '#shared/database/errors.js';
import { updateVersioned } from '#shared/database/optimistic-concurrency.js';
import type { Prisma, TenantTx } from '#shared/database/prisma.js';

import {
  OrganizationCnpjTakenError,
  OrganizationShortNameTakenError,
} from '../application/organization-ports.js';
import type {
  OrganizationListFilter,
  OrganizationPage,
  OrganizationRepository,
  OrganizationTransactions,
} from '../application/organization-ports.js';
import type { Organization } from '../domain/organization.js';

type Row = Prisma.OrganizationGetPayload<object>;

function toDomain(row: Row): Organization {
  const metadata =
    typeof row.metadata === 'object' && row.metadata !== null && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {};
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    shortName: row.shortName,
    cnpj: row.cnpj,
    type: row.type,
    isActive: row.isActive,
    email: row.email,
    phone: row.phone,
    website: row.website,
    addressStreet: row.addressStreet,
    addressNumber: row.addressNumber,
    addressComplement: row.addressComplement,
    addressDistrict: row.addressDistrict,
    addressCity: row.addressCity,
    addressState: row.addressState,
    addressZipCode: row.addressZipCode,
    ibgeCityCode: row.ibgeCityCode,
    logoAttachmentId: row.logoAttachmentId,
    metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdById: row.createdById,
    updatedById: row.updatedById,
    version: row.version,
  };
}

function toCreateData(organization: Organization): Prisma.OrganizationUncheckedCreateInput {
  return {
    id: organization.id,
    tenantId: organization.tenantId,
    name: organization.name,
    shortName: organization.shortName,
    cnpj: organization.cnpj,
    type: organization.type,
    isActive: organization.isActive,
    email: organization.email,
    phone: organization.phone,
    website: organization.website,
    addressStreet: organization.addressStreet,
    addressNumber: organization.addressNumber,
    addressComplement: organization.addressComplement,
    addressDistrict: organization.addressDistrict,
    addressCity: organization.addressCity,
    addressState: organization.addressState,
    addressZipCode: organization.addressZipCode,
    ibgeCityCode: organization.ibgeCityCode,
    logoAttachmentId: organization.logoAttachmentId,
    metadata: organization.metadata as Prisma.InputJsonObject,
    createdAt: organization.createdAt,
    updatedAt: organization.updatedAt,
    createdById: organization.createdById,
    updatedById: organization.updatedById,
    version: organization.version,
  };
}

/** Texto das mensagens da cadeia de causas (nome do índice único violado). */
function messagesOf(error: unknown): string {
  const parts: string[] = [];
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    parts.push(current.message);
  }
  const meta = (error as { meta?: { target?: unknown } } | null)?.meta?.target;
  if (meta !== undefined) parts.push(JSON.stringify(meta));
  return parts.join(' | ');
}

/** Índice único violado → erro da porta: CNPJ ou sigla (`organizations_tenant_id_*_key`). */
function uniqueViolation(error: unknown): Error | null {
  if (!isUniqueViolation(error)) return null;
  return /cnpj/i.test(messagesOf(error))
    ? new OrganizationCnpjTakenError()
    : new OrganizationShortNameTakenError('');
}

/**
 * `organizations` no PostgreSQL (US-101): leituras e escritas no `tx` do caso de uso, sob a RLS do
 * tenant e a extensão de isolamento (que injeta o `tenantId`). Nenhuma exclusão (FA-03).
 */
@Injectable()
export class PrismaOrganizationRepository implements OrganizationRepository {
  async list(tx: TenantTx, filter: OrganizationListFilter): Promise<OrganizationPage> {
    const q = filter.q?.trim();
    const cnpjNeedle = q ? q.replace(/[./\s-]/g, '').toUpperCase() : '';
    const where: Prisma.OrganizationWhereInput = {
      ...(filter.isActive === undefined ? {} : { isActive: filter.isActive }),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { shortName: { contains: q, mode: 'insensitive' } },
              ...(cnpjNeedle === '' ? [] : [{ cnpj: { contains: cnpjNeedle } }]),
            ],
          }
        : {}),
    };
    const [rows, totalItems] = await Promise.all([
      tx.organization.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (filter.page - 1) * filter.pageSize,
        take: filter.pageSize,
      }),
      tx.organization.count({ where }),
    ]);
    return { items: rows.map(toDomain), totalItems };
  }

  async findById(tx: TenantTx, id: string): Promise<Organization | null> {
    const row = await tx.organization.findFirst({ where: { id } });
    return row === null ? null : toDomain(row);
  }

  async findByShortName(tx: TenantTx, shortName: string): Promise<Organization | null> {
    const row = await tx.organization.findFirst({ where: { shortName } });
    return row === null ? null : toDomain(row);
  }

  async findByCnpj(tx: TenantTx, cnpj: string): Promise<Organization | null> {
    const row = await tx.organization.findFirst({ where: { cnpj } });
    return row === null ? null : toDomain(row);
  }

  async insert(tx: TenantTx, organization: Organization): Promise<void> {
    try {
      await tx.organization.create({ data: toCreateData(organization) });
    } catch (error) {
      throw uniqueViolation(error) ?? error;
    }
  }

  async update(tx: TenantTx, organization: Organization, expectedVersion: number): Promise<void> {
    try {
      await updateVersioned(
        { aggregateType: 'Organization', aggregateId: organization.id, expectedVersion },
        () =>
          tx.organization.updateMany({
            where: { id: organization.id, version: expectedVersion },
            data: {
              name: organization.name,
              shortName: organization.shortName,
              cnpj: organization.cnpj,
              type: organization.type,
              isActive: organization.isActive,
              email: organization.email,
              phone: organization.phone,
              website: organization.website,
              addressStreet: organization.addressStreet,
              addressNumber: organization.addressNumber,
              addressComplement: organization.addressComplement,
              addressDistrict: organization.addressDistrict,
              addressCity: organization.addressCity,
              addressState: organization.addressState,
              addressZipCode: organization.addressZipCode,
              ibgeCityCode: organization.ibgeCityCode,
              logoAttachmentId: organization.logoAttachmentId,
              updatedAt: organization.updatedAt,
              updatedById: organization.updatedById,
              version: { increment: 1 },
            },
          }),
      );
    } catch (error) {
      throw uniqueViolation(error) ?? error;
    }
  }

  countActive(tx: TenantTx, excludingId: string): Promise<number> {
    return tx.organization.count({ where: { isActive: true, id: { not: excludingId } } });
  }

  async primaryOrganizationId(tx: TenantTx): Promise<string | null> {
    // `tenants` é tabela de plataforma (sem RLS): o `cf_app` lê só as colunas do GRANT (US-100).
    const { tenantId } = requireRequestContext();
    if (tenantId === null) return null;
    const row = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { primaryOrganizationId: true },
    });
    return row?.primaryOrganizationId ?? null;
  }
}

/** Transações do módulo sobre a `TenantTransaction` (contexto de tenant da requisição). */
@Injectable()
export class PrismaOrganizationTransactions implements OrganizationTransactions {
  constructor(private readonly transaction: TenantTransaction) {}

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.run(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.read(work);
  }
}
