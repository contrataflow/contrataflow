import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { VersionConflictError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';

import {
  DepartmentAcronymTakenError,
  DepartmentNameTakenError,
  DepartmentReferencedError,
} from '../application/department-ports.js';
import type {
  DepartmentLeadership,
  DepartmentListFilter,
  DepartmentLookupFilter,
  DepartmentRepository,
  DepartmentTransactions,
} from '../application/department-ports.js';
import { rebase } from '../domain/department-tree.js';
import type { TreePosition } from '../domain/department-tree.js';
import type { Department } from '../domain/department.js';

/** Minúsculas e sem acentos: a busca do SCR-032 ignora ambos. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function matches(department: Department, q: string | undefined): boolean {
  if (q === undefined) return true;
  const needle = fold(q.trim());
  return [department.name, department.acronym, department.code].some(
    (text) => text !== null && fold(text).includes(needle),
  );
}

/**
 * Unidades em memória (testes e modo de identidade fake de local/dev/test): mesma semântica do
 * adaptador Prisma — isolamento por tenant (o do contexto, como o `app.tenant_id`), unicidade de
 * sigla no órgão e de nome entre irmãos, concorrência otimista por versão e a FK `RESTRICT` das
 * sub-unidades na exclusão. As travas são cobertas pelas transações em memória, que rodam uma de
 * cada vez (`InMemoryDepartmentTransactions`).
 */
export class InMemoryDepartmentRepository implements DepartmentRepository {
  private readonly rows = new Map<string, Department>();

  private tenantId(): string | null {
    return currentRequestContext()?.tenantId ?? null;
  }

  private inTenant(): Department[] {
    const tenantId = this.tenantId();
    return [...this.rows.values()].filter((department) => department.tenantId === tenantId);
  }

  listAll(_tx: TenantTx, filter: DepartmentListFilter): Promise<Department[]> {
    return Promise.resolve(
      this.inTenant()
        .filter(
          (d) => filter.organizationId === undefined || d.organizationId === filter.organizationId,
        )
        .filter((d) => filter.isActive === undefined || d.isActive === filter.isActive)
        .filter((d) => matches(d, filter.q))
        .sort((a, b) => a.path.localeCompare(b.path)),
    );
  }

  lookup(_tx: TenantTx, filter: DepartmentLookupFilter): Promise<Department[]> {
    return Promise.resolve(
      this.inTenant()
        .filter((d) => d.isActive)
        .filter(
          (d) => filter.organizationId === undefined || d.organizationId === filter.organizationId,
        )
        .filter((d) => matches(d, filter.q))
        .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR') || a.id.localeCompare(b.id))
        .slice(0, filter.limit),
    );
  }

  findById(_tx: TenantTx, id: string): Promise<Department | null> {
    return Promise.resolve(this.inTenant().find((d) => d.id === id) ?? null);
  }

  findByIds(_tx: TenantTx, ids: readonly string[]): Promise<Department[]> {
    const wanted = new Set(ids);
    return Promise.resolve(this.inTenant().filter((d) => wanted.has(d.id)));
  }

  findByAcronym(
    _tx: TenantTx,
    organizationId: string,
    acronym: string,
  ): Promise<Department | null> {
    return Promise.resolve(
      this.inTenant().find((d) => d.organizationId === organizationId && d.acronym === acronym) ??
        null,
    );
  }

  findSiblingByName(
    _tx: TenantTx,
    organizationId: string,
    parentId: string | null,
    name: string,
  ): Promise<Department | null> {
    return Promise.resolve(this.siblingNamed(organizationId, parentId, name, null));
  }

  countChildren(_tx: TenantTx, id: string): Promise<number> {
    return Promise.resolve(this.inTenant().filter((d) => d.parentId === id).length);
  }

  idsHeadedBy(_tx: TenantTx, userId: string): Promise<string[]> {
    return Promise.resolve(
      this.inTenant()
        .filter((d) => d.isActive && (d.headUserId === userId || d.deputyUserId === userId))
        .map((d) => d.id),
    );
  }

  leadershipOf(_tx: TenantTx, userId: string): Promise<DepartmentLeadership> {
    const rows = [...this.inTenant()].sort((a, b) => a.id.localeCompare(b.id));
    return Promise.resolve({
      headOf: rows.filter((d) => d.headUserId === userId).map((d) => d.id),
      deputyOf: rows.filter((d) => d.deputyUserId === userId).map((d) => d.id),
    });
  }

  subtreeIds(_tx: TenantTx, rootIds: readonly string[]): Promise<Map<string, string[]>> {
    const rows = this.inTenant();
    const result = new Map<string, string[]>();
    for (const rootId of new Set(rootIds)) {
      const root = rows.find((d) => d.id === rootId);
      if (!root) continue;
      result.set(
        rootId,
        rows.filter((d) => d.path.startsWith(root.path)).map((d) => d.id),
      );
    }
    return Promise.resolve(result);
  }

  insert(_tx: TenantTx, department: Department): Promise<void> {
    const taken = this.takenBy(department);
    if (taken) return Promise.reject(taken);
    this.rows.set(department.id, department);
    return Promise.resolve();
  }

  update(_tx: TenantTx, department: Department, expectedVersion: number): Promise<void> {
    const current = this.current(department.id, expectedVersion);
    if (current instanceof Error) return Promise.reject(current);
    const taken = this.takenBy(department);
    if (taken) return Promise.reject(taken);
    // Como no banco: a edição nunca reescreve a posição na árvore.
    this.rows.set(department.id, {
      ...department,
      parentId: current.parentId,
      path: current.path,
      depth: current.depth,
      version: expectedVersion + 1,
    });
    return Promise.resolve();
  }

  delete(_tx: TenantTx, department: Department, expectedVersion: number): Promise<void> {
    const current = this.current(department.id, expectedVersion);
    if (current instanceof Error) return Promise.reject(current);
    if (this.inTenant().some((d) => d.parentId === department.id)) {
      return Promise.reject(new DepartmentReferencedError('SUBUNITS'));
    }
    this.rows.delete(department.id);
    return Promise.resolve();
  }

  lockTree(): Promise<void> {
    return Promise.resolve();
  }

  lockSubtree(_tx: TenantTx, unit: TreePosition): Promise<number> {
    return Promise.resolve(
      this.inTenant().filter((d) => d.id !== unit.id && d.path.startsWith(unit.path)).length,
    );
  }

  moveSubtree(
    _tx: TenantTx,
    moved: Department,
    from: TreePosition,
    expectedVersion: number,
  ): Promise<number> {
    const current = this.current(moved.id, expectedVersion);
    if (current instanceof Error) return Promise.reject(current);
    if (this.siblingNamed(moved.organizationId, moved.parentId, moved.name, moved.id)) {
      return Promise.reject(new DepartmentNameTakenError());
    }
    const descendants = this.inTenant().filter(
      (d) => d.id !== moved.id && d.path.startsWith(from.path),
    );
    this.rows.set(moved.id, { ...moved, version: expectedVersion + 1 });
    for (const descendant of descendants) {
      this.rows.set(descendant.id, {
        ...descendant,
        ...rebase(descendant, from, moved),
        updatedAt: moved.updatedAt,
        updatedById: moved.updatedById,
      });
    }
    return Promise.resolve(descendants.length);
  }

  private current(id: string, expectedVersion: number): Department | VersionConflictError {
    const current = this.inTenant().find((d) => d.id === id);
    if (current?.version !== expectedVersion) {
      return new VersionConflictError({
        aggregateType: 'Department',
        aggregateId: id,
        expectedVersion,
      });
    }
    return current;
  }

  private siblingNamed(
    organizationId: string,
    parentId: string | null,
    name: string,
    excludingId: string | null,
  ): Department | null {
    const lower = name.toLowerCase();
    return (
      this.inTenant().find(
        (d) =>
          d.id !== excludingId &&
          d.organizationId === organizationId &&
          d.parentId === parentId &&
          d.name.toLowerCase() === lower,
      ) ?? null
    );
  }

  private takenBy(department: Department): Error | null {
    if (
      department.acronym !== null &&
      this.inTenant().some(
        (d) =>
          d.id !== department.id &&
          d.organizationId === department.organizationId &&
          d.acronym === department.acronym,
      )
    ) {
      return new DepartmentAcronymTakenError();
    }
    const parentId = this.rows.get(department.id)?.parentId ?? department.parentId;
    if (this.siblingNamed(department.organizationId, parentId, department.name, department.id)) {
      return new DepartmentNameTakenError();
    }
    return null;
  }

  /** Inspeção e carga de testes: todas as unidades de todos os tenants. */
  snapshot(): readonly Department[] {
    return [...this.rows.values()];
  }

  /** Carga de testes (unidade de outro tenant, estrutura já existente…). */
  seed(...departments: readonly Department[]): void {
    for (const department of departments) this.rows.set(department.id, department);
  }
}

/**
 * Transações simuladas: um `tx` sentinela ativo só durante o trabalho, uma de cada vez — o
 * equivalente em memória das travas da árvore e da subárvore (Concorrência da US-102).
 */
@Injectable()
export class InMemoryDepartmentTransactions implements DepartmentTransactions {
  private queue: Promise<unknown> = Promise.resolve();

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    const next = this.queue.then(() => runSimulatedTransaction(work));
    this.queue = next.catch(() => undefined);
    return next;
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }
}
