import { canChangeTreatmentStatus, TREATMENT_FIELDS } from '@contrataflow/validation';
import type {
  CreateRiskTreatment,
  TreatmentField,
  TreatmentStatus,
  TreatmentType,
  UpdateRiskTreatment,
} from '@contrataflow/validation';

import type { Risk } from './risk.js';

/*
 * `RiskTreatment` (US-034 · DEC-021 · RN-RISK-11..15): ação de prevenção ou contingência de um
 * risco, com responsável, prazo e status próprio. A máquina de status (RN-RISK-15) é a de
 * `@contrataflow/validation` (a mesma da UI); `completedAt` acompanha o `DONE` (RN-RISK-12) e o
 * primeiro tratamento ativo de um risco `OPEN` o leva a `IN_TREATMENT` (RN-RISK-14). Puro: sem
 * NestJS, Prisma nem outro módulo.
 */

export interface RiskTreatment {
  readonly id: string;
  readonly tenantId: string;
  readonly riskId: string;
  readonly processId: string;
  readonly type: TreatmentType;
  readonly description: string;
  readonly responsibleId: string | null;
  readonly responsibleDepartmentId: string | null;
  /** `YYYY-MM-DD` (coluna `date`). */
  readonly dueDate: string | null;
  readonly status: TreatmentStatus;
  readonly completedAt: Date | null;
  readonly notes: string | null;
  readonly sortOrder: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdById: string | null;
  readonly updatedById: string | null;
  readonly deletedAt: Date | null;
  readonly deletedById: string | null;
  readonly version: number;
}

export interface NewTreatmentContext {
  readonly id: string;
  readonly risk: Pick<Risk, 'id' | 'tenantId' | 'processId'>;
  readonly sortOrder: number;
  readonly now: Date;
  readonly userId: string | null;
}

/** `RiskTreatment.create` (RN-RISK-11/13): `status = PLANNED`, ao fim da lista do risco. */
export function createRiskTreatment(
  body: CreateRiskTreatment,
  context: NewTreatmentContext,
): RiskTreatment {
  return {
    id: context.id,
    tenantId: context.risk.tenantId,
    riskId: context.risk.id,
    processId: context.risk.processId,
    type: body.type,
    description: body.description,
    responsibleId: body.responsibleId ?? null,
    responsibleDepartmentId: body.responsibleDepartmentId ?? null,
    dueDate: body.dueDate ?? null,
    status: 'PLANNED',
    completedAt: null,
    notes: body.notes ?? null,
    sortOrder: context.sortOrder,
    createdAt: context.now,
    updatedAt: context.now,
    createdById: context.userId,
    updatedById: context.userId,
    deletedAt: null,
    deletedById: null,
    version: 1,
  };
}

/** Transição recusada (RN-RISK-15 → 409 `INVALID_STATE`). */
export interface TreatmentTransitionRefused {
  readonly from: TreatmentStatus;
  readonly to: TreatmentStatus;
}

export interface TreatmentStatusChange {
  readonly from: TreatmentStatus;
  readonly to: TreatmentStatus;
}

export type PatchedTreatment =
  | {
      readonly ok: true;
      readonly next: RiskTreatment;
      /** `null` = status inalterado (edição comum — `UPDATED`). */
      readonly statusChange: TreatmentStatusChange | null;
    }
  | { readonly ok: false; readonly refused: TreatmentTransitionRefused };

/**
 * `RiskTreatment.changeStatus` (RN-RISK-12/15): só as transições permitidas; `DONE` grava
 * `completedAt = now`, qualquer outro status o limpa. Mesmo status = sem mudança.
 */
export function changeTreatmentStatus(
  treatment: RiskTreatment,
  next: TreatmentStatus,
  now: Date,
): PatchedTreatment {
  if (next === treatment.status) return { ok: true, next: treatment, statusChange: null };
  if (!canChangeTreatmentStatus(treatment.status, next)) {
    return { ok: false, refused: { from: treatment.status, to: next } };
  }
  return {
    ok: true,
    next: { ...treatment, status: next, completedAt: next === 'DONE' ? now : null },
    statusChange: { from: treatment.status, to: next },
  };
}

/** Aplica o patch de RSK-07 (`undefined` = mantém; `null` limpa os opcionais) e o status. */
export function patchRiskTreatment(
  treatment: RiskTreatment,
  patch: UpdateRiskTreatment,
  now: Date,
): PatchedTreatment {
  const edited: RiskTreatment = {
    ...treatment,
    type: patch.type ?? treatment.type,
    description: patch.description ?? treatment.description,
    responsibleId:
      patch.responsibleId === undefined ? treatment.responsibleId : patch.responsibleId,
    responsibleDepartmentId:
      patch.responsibleDepartmentId === undefined
        ? treatment.responsibleDepartmentId
        : patch.responsibleDepartmentId,
    dueDate: patch.dueDate === undefined ? treatment.dueDate : patch.dueDate,
    notes: patch.notes === undefined ? treatment.notes : patch.notes,
    sortOrder: patch.sortOrder ?? treatment.sortOrder,
  };
  if (patch.status === undefined) return { ok: true, next: edited, statusChange: null };
  return changeTreatmentStatus(edited, patch.status, now);
}

export interface TreatmentChange {
  readonly field: TreatmentField;
  readonly old: unknown;
  readonly new: unknown;
}

/** Campos editáveis que mudaram, na ordem canônica (`before = null` = criação). */
export function diffRiskTreatment(
  before: RiskTreatment | null,
  after: RiskTreatment,
): TreatmentChange[] {
  return TREATMENT_FIELDS.flatMap((field) => {
    const old = before === null ? null : before[field];
    const value = after[field];
    return old === value ? [] : [{ field, old, new: value }];
  });
}

/** Grava autoria e data da alteração (a `version` sobe no repositório — DEC-055). */
export function touchRiskTreatment(
  treatment: RiskTreatment,
  now: Date,
  userId: string | null,
): RiskTreatment {
  return { ...treatment, updatedAt: now, updatedById: userId };
}

/** Próxima posição na lista do risco: depois da última (FA-02). */
export function nextTreatmentSortOrder(siblings: readonly Pick<RiskTreatment, 'sortOrder'>[]) {
  return siblings.reduce((max, sibling) => Math.max(max, sibling.sortOrder + 1), 0);
}
