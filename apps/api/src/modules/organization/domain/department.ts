import { SECRETARIAT_TYPES } from '@contrataflow/validation';
import type { CreateDepartment, DepartmentType, UpdateDepartment } from '@contrataflow/validation';

import type { AuditChange } from '#shared/audit/audit-trail.js';

import { positionUnder } from './department-tree.js';
import type { TreePosition } from './department-tree.js';

/*
 * `Department` (entities.md §4 · US-102 · RN-TEN-44..51). Funções puras sobre um registro imutável:
 * nada aqui lê banco, relógio ou contexto. Formatos e tamanhos são dos schemas Zod compartilhados;
 * aqui ficam as regras do agregado (caminho, titular ≠ substituto, campos que a edição não muda).
 */

export interface Department {
  readonly id: string;
  readonly tenantId: string;
  readonly organizationId: string;
  /** `null` = raiz do órgão. */
  readonly parentId: string | null;
  readonly type: DepartmentType;
  readonly name: string;
  readonly acronym: string | null;
  readonly code: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly headUserId: string | null;
  readonly deputyUserId: string | null;
  /** `/<idRaiz>/…/<id>/` — calculado pela aplicação (RN-TEN-45). */
  readonly path: string;
  readonly depth: number;
  readonly isActive: boolean;
  readonly sortOrder: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdById: string | null;
  readonly updatedById: string | null;
  readonly version: number;
}

/** Campos que a edição (DEP-05) pode alterar, na ordem de `changedFields`. */
export const DEPARTMENT_UPDATABLE_FIELDS = [
  'type',
  'name',
  'acronym',
  'code',
  'email',
  'phone',
  'headUserId',
  'deputyUserId',
  'sortOrder',
] as const satisfies readonly (keyof Department)[];
export type DepartmentUpdatableField = (typeof DEPARTMENT_UPDATABLE_FIELDS)[number];

/** RN-TEN-49: "Secretaria" = tipo `SECRETARIAT`/`BOARD` ou raiz do órgão. */
export function isSecretariat(department: Pick<Department, 'type' | 'depth'>): boolean {
  return department.depth === 0 || SECRETARIAT_TYPES.includes(department.type);
}

/** V-07 · RN-TEN-48: titular e substituto são a mesma pessoa. */
export class HeadEqualsDeputyError extends Error {
  constructor() {
    super('Titular e substituto devem ser pessoas diferentes.');
    this.name = 'HeadEqualsDeputyError';
  }
}

/** DEP-05 com `organizationId`/`parentId` diferentes do atual (o órgão não muda; mover é DEP-06). */
export class DepartmentFieldNotAllowedError extends Error {
  constructor(readonly field: 'organizationId' | 'parentId') {
    super(`O campo ${field} não muda pela edição da unidade.`);
    this.name = 'DepartmentFieldNotAllowedError';
  }
}

export interface CreateDepartmentContext {
  readonly id: string;
  readonly tenantId: string;
  /** Unidade superior já validada (mesmo órgão — RN-TEN-44); `null` = raiz. */
  readonly parent: TreePosition | null;
  readonly now: Date;
  readonly userId: string | null;
}

/** `Department.create` (RN-TEN-44/45/48): ativa, posição calculada sob o pai, versão 1. */
export function createDepartment(
  input: CreateDepartment,
  context: CreateDepartmentContext,
): Department {
  const headUserId = input.headUserId ?? null;
  const deputyUserId = input.deputyUserId ?? null;
  if (headUserId !== null && headUserId === deputyUserId) throw new HeadEqualsDeputyError();
  const { path, depth } = positionUnder(context.id, context.parent);
  return {
    id: context.id,
    tenantId: context.tenantId,
    organizationId: input.organizationId,
    parentId: context.parent?.id ?? null,
    type: input.type,
    name: input.name,
    acronym: input.acronym ?? null,
    code: input.code ?? null,
    email: input.email ?? null,
    phone: input.phone ?? null,
    headUserId,
    deputyUserId,
    path,
    depth,
    isActive: true,
    sortOrder: input.sortOrder ?? 0,
    createdAt: context.now,
    updatedAt: context.now,
    createdById: context.userId,
    updatedById: context.userId,
    version: 1,
  };
}

export interface DepartmentChangeContext {
  readonly now: Date;
  readonly userId: string | null;
}

export interface DepartmentUpdateResult {
  readonly next: Department;
  readonly changedFields: readonly DepartmentUpdatableField[];
  /** Valor anterior e novo de cada campo alterado (auditoria `department.update`). */
  readonly changes: readonly AuditChange[];
  /** Titular/substituto novos a validar (RN-TEN-48): só os que mudaram e não foram limpos. */
  readonly staffToValidate: readonly ('headUserId' | 'deputyUserId')[];
}

/**
 * `Department.update` (DEP-05 · RN-TEN-44..48): aplica só o que veio e mudou; `null` limpa um
 * opcional. `organizationId`/`parentId` só são aceitos iguais aos atuais. O par titular/substituto
 * resultante nunca é a mesma pessoa.
 */
export function updateDepartment(
  current: Department,
  patch: UpdateDepartment,
  context: DepartmentChangeContext,
): DepartmentUpdateResult {
  if (patch.organizationId !== undefined && patch.organizationId !== current.organizationId) {
    throw new DepartmentFieldNotAllowedError('organizationId');
  }
  if (patch.parentId !== undefined && (patch.parentId ?? null) !== current.parentId) {
    throw new DepartmentFieldNotAllowedError('parentId');
  }

  const changedFields: DepartmentUpdatableField[] = [];
  const changes: AuditChange[] = [];
  const draft: Record<string, unknown> = { ...current };
  for (const field of DEPARTMENT_UPDATABLE_FIELDS) {
    const sent = patch[field];
    if (sent === undefined) continue;
    const before = current[field];
    if (before === sent) continue;
    draft[field] = sent;
    changedFields.push(field);
    changes.push({ path: field, old: before, new: sent });
  }
  const merged = draft as unknown as Department;
  if (merged.headUserId !== null && merged.headUserId === merged.deputyUserId) {
    throw new HeadEqualsDeputyError();
  }

  const next: Department = {
    ...merged,
    ...(changedFields.length > 0 ? { updatedAt: context.now, updatedById: context.userId } : {}),
  };
  const staffToValidate = (['headUserId', 'deputyUserId'] as const).filter(
    (field) => changedFields.includes(field) && next[field] !== null,
  );
  return { next, changedFields, changes, staffToValidate };
}

/** DEP-07/08 (RN-TEN-50): nova situação, ou `null` se já está nela (200 sem efeitos). */
export function setDepartmentActive(
  current: Department,
  isActive: boolean,
  context: DepartmentChangeContext,
): Department | null {
  if (current.isActive === isActive) return null;
  return { ...current, isActive, updatedAt: context.now, updatedById: context.userId };
}

/** DEP-06: a unidade sob o novo pai (`null` = raiz), com `path`/`depth` recalculados. */
export function moveDepartment(
  current: Department,
  target: TreePosition | null,
  context: DepartmentChangeContext,
): Department {
  const { path, depth } = positionUnder(current.id, target);
  return {
    ...current,
    parentId: target?.id ?? null,
    path,
    depth,
    updatedAt: context.now,
    updatedById: context.userId,
  };
}
