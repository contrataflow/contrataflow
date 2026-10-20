import type { TenantTx } from '#shared/database/prisma.js';

import type { TreePosition } from '../domain/department-tree.js';
import type { Department } from '../domain/department.js';

/*
 * Portas da aplicação das unidades (US-102): implementadas em `infrastructure/` (Prisma) e em
 * memória nos testes e no modo de identidade fake (local/dev/test sem banco).
 */

/** Sigla já usada no órgão (índice único parcial `departments_acronym_key` — RN-TEN-47 · V-04). */
export class DepartmentAcronymTakenError extends Error {
  constructor() {
    super('Sigla de unidade já usada no órgão.');
    this.name = 'DepartmentAcronymTakenError';
  }
}

/** Nome já usado entre irmãos (índice `departments_sibling_name_key` — RN-TEN-47 · V-03). */
export class DepartmentNameTakenError extends Error {
  constructor() {
    super('Nome de unidade já usado no mesmo nível.');
    this.name = 'DepartmentNameTakenError';
  }
}

/** Referência que impede a exclusão física (RN-TEN-51 · V-08). */
export type DepartmentReferenceKind = 'SUBUNITS' | 'ASSIGNMENTS' | 'WORKFLOW_STAGES' | 'OTHER';

/** `DELETE` recusado por uma FK `ON DELETE RESTRICT` que aponta para a unidade. */
export class DepartmentReferencedError extends Error {
  constructor(readonly reference: DepartmentReferenceKind) {
    super('Unidade referenciada.');
    this.name = 'DepartmentReferencedError';
  }
}

export interface DepartmentListFilter {
  readonly organizationId?: string;
  readonly isActive?: boolean;
  /** Nome, sigla ou código (contém, sem diferenciar maiúsculas nem acentos). */
  readonly q?: string;
}

export interface DepartmentLookupFilter {
  readonly organizationId?: string;
  readonly q?: string;
  readonly limit: number;
}

/** Titularidades e substituições de um usuário (`leadershipOf`). */
export interface DepartmentLeadership {
  readonly headOf: readonly string[];
  readonly deputyOf: readonly string[];
}

export interface DepartmentRepository {
  /** Todas as unidades do tenant que casam com o filtro (a ordem da árvore é da aplicação). */
  listAll(tx: TenantTx, filter: DepartmentListFilter): Promise<Department[]>;
  /** Unidades ATIVAS por nome (DEP-02). */
  lookup(tx: TenantTx, filter: DepartmentLookupFilter): Promise<Department[]>;
  /** `null` se o id não existe NO TENANT da transação (outro tenant → `null`, nunca o registro). */
  findById(tx: TenantTx, id: string): Promise<Department | null>;
  /** Unidades do tenant da transação por id, numa leitura (`IN (...)`); ids de fora não voltam. */
  findByIds(tx: TenantTx, ids: readonly string[]): Promise<Department[]>;
  findByAcronym(tx: TenantTx, organizationId: string, acronym: string): Promise<Department | null>;
  /** Irmã com o mesmo nome, sem diferenciar maiúsculas (`parentId` nulo = raízes do órgão). */
  findSiblingByName(
    tx: TenantTx,
    organizationId: string,
    parentId: string | null,
    name: string,
  ): Promise<Department | null>;
  countChildren(tx: TenantTx, id: string): Promise<number>;
  /** Unidades ATIVAS de que o usuário é titular ou substituto (US-041 · POL-05 · permissions.md §7). */
  idsHeadedBy(tx: TenantTx, userId: string): Promise<string[]>;
  /**
   * Unidades (ativas ou não) de que o usuário é titular e as de que é substituto, separadas
   * (US-056: aprovações `DEPARTMENT_HEAD` pendentes — o substituto só com `allowDeputy`, POL-03).
   */
  leadershipOf(tx: TenantTx, userId: string): Promise<DepartmentLeadership>;
  /**
   * Cada raiz de `rootIds` existente no tenant com ela e as descendentes (`path LIKE '<path>%'` —
   * US-097: escopos com subárvore).
   */
  subtreeIds(tx: TenantTx, rootIds: readonly string[]): Promise<Map<string, string[]>>;
  /** @throws DepartmentAcronymTakenError @throws DepartmentNameTakenError */
  insert(tx: TenantTx, department: Department): Promise<void>;
  /**
   * Grava a unidade com `version = version + 1` condicionada a `expectedVersion` (DEC-055).
   * @throws VersionConflictError @throws DepartmentAcronymTakenError @throws DepartmentNameTakenError
   */
  update(tx: TenantTx, department: Department, expectedVersion: number): Promise<void>;
  /**
   * Exclusão física condicionada à versão. @throws VersionConflictError
   * @throws DepartmentReferencedError (FK `RESTRICT` de sub-unidade, lotação, etapa de workflow…)
   */
  delete(tx: TenantTx, department: Department, expectedVersion: number): Promise<void>;
  /**
   * Serializa as mudanças de estrutura do órgão até o fim da transação (trava consultiva por
   * tenant + órgão): criação sob um pai e movimentação nunca leem um caminho que outra transação
   * está reescrevendo (Concorrência da US-102).
   */
  lockTree(tx: TenantTx, organizationId: string): Promise<void>;
  /** `SELECT … FOR UPDATE` da subárvore (`path LIKE '<path>%'`); devolve quantos descendentes há. */
  lockSubtree(tx: TenantTx, unit: TreePosition): Promise<number>;
  /**
   * Grava a unidade movida (versionada, como `update`) e reescreve `path`/`depth` de toda a
   * subárvore a partir de `from` (posição anterior), na mesma transação (RN-TEN-45/46).
   * @throws VersionConflictError @throws DepartmentNameTakenError
   */
  moveSubtree(
    tx: TenantTx,
    moved: Department,
    from: TreePosition,
    expectedVersion: number,
  ): Promise<number>;
}

export const DEPARTMENT_REPOSITORY = Symbol('DepartmentRepository');

/** Transações do módulo: Prisma (`TenantTransaction`) ou simulada em memória. */
export interface DepartmentTransactions {
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
}

export const DEPARTMENT_TRANSACTIONS = Symbol('DepartmentTransactions');

export type DepartmentClock = () => Date;

export const DEPARTMENT_CLOCK = Symbol('DepartmentClock');
