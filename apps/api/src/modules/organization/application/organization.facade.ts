import type { DepartmentType } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { DEPARTMENT_REPOSITORY } from './department-ports.js';
import type { DepartmentLeadership, DepartmentRepository } from './department-ports.js';

export type { DepartmentLeadership } from './department-ports.js';

/** Unidade vista por quem valida designações de aprovador (US-061 · RN-DOC-07). */
export interface DepartmentForApproval {
  readonly id: string;
  readonly isActive: boolean;
  /** Titular (`headUserId`); `null` = unidade sem titular cadastrado. */
  readonly headUserId: string | null;
  /** Substituto (`deputyUserId` — decide quando `allowDeputy`, US-051/US-052). */
  readonly deputyUserId: string | null;
}

/**
 * Unidade vista por quem a referencia num cadastro (US-001: secretaria/setor solicitante — RN-PROC-02
 * — e unidade da etapa inicial).
 */
export interface DepartmentReference {
  readonly id: string;
  readonly organizationId: string;
  readonly parentId: string | null;
  readonly type: DepartmentType;
  readonly name: string;
  /** Caminho materializado `/<idRaiz>/…/<id>/` (RN-TEN-45): subárvore = prefixo. */
  readonly path: string;
  readonly isActive: boolean;
  readonly headUserId: string | null;
}

/**
 * API pública do módulo `organization` para os demais módulos (DEC-041): métodos de intenção,
 * nunca exposição de repositório.
 */
@Injectable()
export class OrganizationFacade {
  constructor(@Inject(DEPARTMENT_REPOSITORY) private readonly departments: DepartmentRepository) {}

  /**
   * Unidades do tenant da transação por id (ativas ou não — quem chama decide), lidas no `tx` do
   * chamador. Id inexistente no tenant (inclusive de outro tenant) fica fora do mapa.
   */
  async departmentReferences(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, DepartmentReference>> {
    const references = new Map<string, DepartmentReference>();
    // Uma leitura por chamada (`IN (...)`), nunca uma por unidade (US-054 — sem N+1).
    const found = await this.departments.findByIds(tx, [...new Set(ids)]);
    for (const department of found) {
      references.set(department.id, {
        id: department.id,
        organizationId: department.organizationId,
        parentId: department.parentId,
        type: department.type,
        name: department.name,
        path: department.path,
        isActive: department.isActive,
        headUserId: department.headUserId,
      });
    }
    return references;
  }

  /**
   * Unidades ATIVAS do tenant da transação por nome, sigla ou código (US-072 · CMT-05 —
   * autocomplete de menções), por nome, até `limit`.
   */
  async searchActiveDepartments(
    tx: TenantTx,
    q: string,
    limit: number,
  ): Promise<{ readonly id: string; readonly name: string; readonly acronym: string | null }[]> {
    const found = await this.departments.lookup(tx, { q, limit });
    return found.map((department) => ({
      id: department.id,
      name: department.name,
      acronym: department.acronym,
    }));
  }

  /**
   * A unidade e toda a sua subárvore (caminho materializado — RN-TEN-45), no tenant da transação
   * (US-076: filtro do dashboard por unidade "com subárvore" — RN-DASH-09). Inexistente = `[]`.
   */
  async subtreeDepartmentIds(tx: TenantTx, departmentId: string): Promise<string[]> {
    return (await this.departments.subtreeIds(tx, [departmentId])).get(departmentId) ?? [];
  }

  /** Nomes das unidades do tenant da transação (timeline e apresentação de processos — US-001). */
  async departmentNames(tx: TenantTx, ids: readonly string[]): Promise<Map<string, string>> {
    const references = await this.departmentReferences(tx, ids);
    return new Map([...references].map(([id, reference]) => [id, reference.name]));
  }

  /**
   * Unidade do tenant da transação (US-102), lida no `tx` do chamador, ou `null` se não existir
   * nele (outro tenant = inexistente).
   */
  /**
   * Unidades ativas de que o usuário é titular ou substituto, no tenant da transação (US-041:
   * atribuir responsável sem `PROCESS_ASSIGN` amplo — POL-05 · permissions.md §7).
   */
  departmentsHeadedBy(tx: TenantTx, userId: string): Promise<string[]> {
    return this.departments.idsHeadedBy(tx, userId);
  }

  /**
   * Titularidades e substituições do usuário no tenant da transação (US-056 · POL-03): a caixa de
   * tarefas lista as aprovações `DEPARTMENT_HEAD` do titular e, com `allowDeputy`, do substituto.
   */
  departmentLeadership(tx: TenantTx, userId: string): Promise<DepartmentLeadership> {
    return this.departments.leadershipOf(tx, userId);
  }

  async findDepartmentForApproval(
    tx: TenantTx,
    departmentId: string,
  ): Promise<DepartmentForApproval | null> {
    const department = await this.departments.findById(tx, departmentId);
    if (!department) return null;
    return {
      id: department.id,
      isActive: department.isActive,
      headUserId: department.headUserId,
      deputyUserId: department.deputyUserId,
    };
  }
}
