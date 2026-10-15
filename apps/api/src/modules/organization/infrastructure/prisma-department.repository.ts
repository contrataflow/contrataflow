import { Injectable } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import { TenantTransaction } from '#shared/database/database.module.js';
import { isForeignKeyViolation, isUniqueViolation } from '#shared/database/errors.js';
import { updateVersioned } from '#shared/database/optimistic-concurrency.js';
import type { Prisma, TenantTx } from '#shared/database/prisma.js';
import { withLockTiming } from '#shared/database/row-lock.js';

import {
  DepartmentAcronymTakenError,
  DepartmentNameTakenError,
  DepartmentReferencedError,
} from '../application/department-ports.js';
import type {
  DepartmentListFilter,
  DepartmentLookupFilter,
  DepartmentReferenceKind,
  DepartmentRepository,
  DepartmentTransactions,
} from '../application/department-ports.js';
import type { TreePosition } from '../domain/department-tree.js';
import type { Department } from '../domain/department.js';

type Row = Prisma.DepartmentGetPayload<object>;

function toDomain(row: Row): Department {
  return {
    id: row.id,
    tenantId: row.tenantId,
    organizationId: row.organizationId,
    parentId: row.parentId,
    type: row.type,
    name: row.name,
    acronym: row.acronym,
    code: row.code,
    email: row.email,
    phone: row.phone,
    headUserId: row.headUserId,
    deputyUserId: row.deputyUserId,
    path: row.path,
    depth: row.depth,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdById: row.createdById,
    updatedById: row.updatedById,
    version: row.version,
  };
}

/** Texto da cadeia do erro (mensagens e `meta`), onde aparece o nome do índice/constraint. */
function textOf(error: unknown): string {
  const parts: string[] = [];
  const pending: unknown[] = [error];
  for (let visited = 0; pending.length > 0 && visited < 16; visited += 1) {
    const current = pending.shift();
    if (current === null || typeof current !== 'object') continue;
    const record = current as Record<string, unknown>;
    for (const key of ['message', 'originalMessage', 'constraint', 'field_name']) {
      if (typeof record[key] === 'string') parts.push(record[key]);
    }
    if (record.target !== undefined) parts.push(JSON.stringify(record.target));
    pending.push(record.cause, record.meta, record.driverAdapterError);
  }
  return parts.join(' | ');
}

/** Índice único violado → erro da porta: sigla (`departments_acronym_key`) ou nome entre irmãos. */
function uniqueViolation(error: unknown): Error | null {
  if (!isUniqueViolation(error)) return null;
  return /acronym/i.test(textOf(error))
    ? new DepartmentAcronymTakenError()
    : new DepartmentNameTakenError();
}

/** FK `ON DELETE RESTRICT` que barrou a exclusão → tipo de referência (RN-TEN-51). */
function referenceKind(error: unknown): DepartmentReferenceKind {
  const text = textOf(error);
  if (text.includes('departments_parent_fkey')) return 'SUBUNITS';
  if (text.includes('membership_departments')) return 'ASSIGNMENTS';
  if (text.includes('workflow_stages')) return 'WORKFLOW_STAGES';
  return 'OTHER';
}

/** Busca textual: nome, sigla ou código (contém, sem diferenciar maiúsculas). */
function searchWhere(q: string | undefined): Prisma.DepartmentWhereInput {
  const needle = q?.trim();
  if (!needle) return {};
  return {
    OR: [
      { name: { contains: needle, mode: 'insensitive' } },
      { acronym: { contains: needle, mode: 'insensitive' } },
      { code: { contains: needle, mode: 'insensitive' } },
    ],
  };
}

/**
 * `departments` no PostgreSQL (US-102): leituras e escritas no `tx` do caso de uso, sob a RLS do
 * tenant e a extensão de isolamento (que injeta o `tenantId`). `path`/`depth`/`parentId` só mudam
 * por `moveSubtree` — a edição comum nunca os reescreve (sem perda de atualização numa
 * movimentação concorrente).
 */
@Injectable()
export class PrismaDepartmentRepository implements DepartmentRepository {
  async listAll(tx: TenantTx, filter: DepartmentListFilter): Promise<Department[]> {
    const rows = await tx.department.findMany({
      where: {
        ...(filter.organizationId === undefined ? {} : { organizationId: filter.organizationId }),
        ...(filter.isActive === undefined ? {} : { isActive: filter.isActive }),
        ...searchWhere(filter.q),
      },
      orderBy: [{ path: 'asc' }],
    });
    return rows.map(toDomain);
  }

  async lookup(tx: TenantTx, filter: DepartmentLookupFilter): Promise<Department[]> {
    const rows = await tx.department.findMany({
      where: {
        isActive: true,
        ...(filter.organizationId === undefined ? {} : { organizationId: filter.organizationId }),
        ...searchWhere(filter.q),
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: filter.limit,
    });
    return rows.map(toDomain);
  }

  async findById(tx: TenantTx, id: string): Promise<Department | null> {
    const row = await tx.department.findFirst({ where: { id } });
    return row === null ? null : toDomain(row);
  }

  async findByAcronym(
    tx: TenantTx,
    organizationId: string,
    acronym: string,
  ): Promise<Department | null> {
    const row = await tx.department.findFirst({ where: { organizationId, acronym } });
    return row === null ? null : toDomain(row);
  }

  async findSiblingByName(
    tx: TenantTx,
    organizationId: string,
    parentId: string | null,
    name: string,
  ): Promise<Department | null> {
    const row = await tx.department.findFirst({
      where: { organizationId, parentId, name: { equals: name, mode: 'insensitive' } },
    });
    return row === null ? null : toDomain(row);
  }

  countChildren(tx: TenantTx, id: string): Promise<number> {
    return tx.department.count({ where: { parentId: id } });
  }

  async insert(tx: TenantTx, department: Department): Promise<void> {
    try {
      await tx.department.create({
        data: {
          id: department.id,
          tenantId: department.tenantId,
          organizationId: department.organizationId,
          parentId: department.parentId,
          type: department.type,
          name: department.name,
          acronym: department.acronym,
          code: department.code,
          email: department.email,
          phone: department.phone,
          headUserId: department.headUserId,
          deputyUserId: department.deputyUserId,
          path: department.path,
          depth: department.depth,
          isActive: department.isActive,
          sortOrder: department.sortOrder,
          createdAt: department.createdAt,
          updatedAt: department.updatedAt,
          createdById: department.createdById,
          updatedById: department.updatedById,
          version: department.version,
        },
      });
    } catch (error) {
      throw uniqueViolation(error) ?? error;
    }
  }

  async update(tx: TenantTx, department: Department, expectedVersion: number): Promise<void> {
    try {
      await updateVersioned(
        { aggregateType: 'Department', aggregateId: department.id, expectedVersion },
        () =>
          tx.department.updateMany({
            where: { id: department.id, version: expectedVersion },
            data: {
              type: department.type,
              name: department.name,
              acronym: department.acronym,
              code: department.code,
              email: department.email,
              phone: department.phone,
              headUserId: department.headUserId,
              deputyUserId: department.deputyUserId,
              isActive: department.isActive,
              sortOrder: department.sortOrder,
              updatedAt: department.updatedAt,
              updatedById: department.updatedById,
              version: { increment: 1 },
            },
          }),
      );
    } catch (error) {
      throw uniqueViolation(error) ?? error;
    }
  }

  async delete(tx: TenantTx, department: Department, expectedVersion: number): Promise<void> {
    try {
      await updateVersioned(
        { aggregateType: 'Department', aggregateId: department.id, expectedVersion },
        () => tx.department.deleteMany({ where: { id: department.id, version: expectedVersion } }),
      );
    } catch (error) {
      if (isForeignKeyViolation(error)) throw new DepartmentReferencedError(referenceKind(error));
      throw error;
    }
  }

  async lockTree(tx: TenantTx, organizationId: string): Promise<void> {
    const { tenantId } = requireRequestContext();
    const key = `departments:${tenantId ?? ''}:${organizationId}`;
    await withLockTiming(
      { lockType: 'advisory', tableName: 'departments' },
      () => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
    );
  }

  async lockSubtree(tx: TenantTx, unit: TreePosition): Promise<number> {
    const { tenantId } = requireRequestContext();
    const rows = await withLockTiming(
      { lockType: 'FOR UPDATE', tableName: 'departments' },
      () =>
        tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM departments
         WHERE tenant_id = ${tenantId}::uuid AND path LIKE ${`${unit.path}%`}
         ORDER BY path
           FOR UPDATE`,
    );
    return Math.max(0, rows.length - 1);
  }

  async moveSubtree(
    tx: TenantTx,
    moved: Department,
    from: TreePosition,
    expectedVersion: number,
  ): Promise<number> {
    const { tenantId } = requireRequestContext();
    try {
      await updateVersioned(
        { aggregateType: 'Department', aggregateId: moved.id, expectedVersion },
        () =>
          tx.department.updateMany({
            where: { id: moved.id, version: expectedVersion },
            data: {
              parentId: moved.parentId,
              path: moved.path,
              depth: moved.depth,
              updatedAt: moved.updatedAt,
              updatedById: moved.updatedById,
              version: { increment: 1 },
            },
          }),
      );
    } catch (error) {
      throw uniqueViolation(error) ?? error;
    }
    // Descendentes: troca do prefixo do caminho e ajuste da profundidade, num único UPDATE.
    return tx.$executeRaw`
      UPDATE departments
         SET path = ${moved.path} || substr(path, ${from.path.length + 1}),
             depth = depth + ${moved.depth - from.depth},
             updated_at = ${moved.updatedAt},
             updated_by_id = ${moved.updatedById}::uuid
       WHERE tenant_id = ${tenantId}::uuid
         AND path LIKE ${`${from.path}%`}
         AND id <> ${moved.id}::uuid`;
  }
}

/** Transações do módulo sobre a `TenantTransaction` (contexto de tenant da requisição). */
@Injectable()
export class PrismaDepartmentTransactions implements DepartmentTransactions {
  constructor(private readonly transaction: TenantTransaction) {}

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.run(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.read(work);
  }
}
