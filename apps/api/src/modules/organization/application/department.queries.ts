import type {
  DepartmentDto,
  DepartmentListQuery,
  DepartmentLookupItem,
  DepartmentLookupQuery,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { DEPARTMENT_REPOSITORY, DEPARTMENT_TRANSACTIONS } from './department-ports.js';
import type { DepartmentRepository, DepartmentTransactions } from './department-ports.js';
import { departmentNotFound } from './department.errors.js';
import { toDepartmentDto, toDepartmentLookupItem } from './department.view.js';
import { treeOrder } from '../domain/department-tree.js';

/** Itens do DEP-02 (seletor com busca): o suficiente para escolher, sem paginação. */
export const DEPARTMENT_LOOKUP_LIMIT = 50;

export interface DepartmentListResult {
  readonly items: readonly DepartmentDto[];
  readonly totalItems: number;
}

/**
 * `ListDepartmentsQuery` — DEP-01 (US-102): capacidade implícita do vínculo ativo (seletores de
 * unidade em processos, aprovações e atribuição). Lista plana na ordem da árvore — pais antes dos
 * filhos, irmãos por `sortOrder` e nome — paginada depois da ordenação (centenas de unidades por
 * órgão); `parentId`/`path`/`depth` permitem ao cliente montar a árvore.
 */
@Injectable()
export class ListDepartmentsQuery {
  constructor(
    @Inject(DEPARTMENT_REPOSITORY) private readonly departments: DepartmentRepository,
    @Inject(DEPARTMENT_TRANSACTIONS) private readonly transactions: DepartmentTransactions,
  ) {}

  execute(query: DepartmentListQuery): Promise<DepartmentListResult> {
    return this.transactions.read(async (tx) => {
      const all = await this.departments.listAll(tx, {
        ...(query.organizationId === undefined ? {} : { organizationId: query.organizationId }),
        ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
        ...(query.q === undefined ? {} : { q: query.q }),
      });
      const ordered = treeOrder(all);
      const start = (query.page - 1) * query.pageSize;
      return {
        items: ordered.slice(start, start + query.pageSize).map(toDepartmentDto),
        totalItems: ordered.length,
      };
    });
  }
}

/** `LookupDepartmentsQuery` — DEP-02: só unidades ativas (RN-TEN-50), por nome. */
@Injectable()
export class LookupDepartmentsQuery {
  constructor(
    @Inject(DEPARTMENT_REPOSITORY) private readonly departments: DepartmentRepository,
    @Inject(DEPARTMENT_TRANSACTIONS) private readonly transactions: DepartmentTransactions,
  ) {}

  execute(query: DepartmentLookupQuery): Promise<DepartmentLookupItem[]> {
    return this.transactions.read(async (tx) => {
      const found = await this.departments.lookup(tx, {
        ...(query.organizationId === undefined ? {} : { organizationId: query.organizationId }),
        ...(query.q === undefined ? {} : { q: query.q }),
        limit: DEPARTMENT_LOOKUP_LIMIT,
      });
      return found.map(toDepartmentLookupItem);
    });
  }
}

/** `GetDepartmentQuery` — DEP-04: outro tenant e inexistente são indistinguíveis (404). */
@Injectable()
export class GetDepartmentQuery {
  constructor(
    @Inject(DEPARTMENT_REPOSITORY) private readonly departments: DepartmentRepository,
    @Inject(DEPARTMENT_TRANSACTIONS) private readonly transactions: DepartmentTransactions,
  ) {}

  execute(id: string): Promise<DepartmentDto> {
    return this.transactions.read(async (tx) => {
      const department = await this.departments.findById(tx, id);
      if (!department) throw departmentNotFound();
      return toDepartmentDto(department);
    });
  }
}
