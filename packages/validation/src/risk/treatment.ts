import { z } from 'zod';

import { uuidV7Schema } from '../common/identifiers.js';

/*
 * Ações de tratamento dos riscos (US-034 · DEC-021 · entities.md `RiskTreatment` · api/08-risks.md
 * RSK-06..08). Os MESMOS schemas validam o `TreatmentFormDrawer` do SCR-011 e o corpo da API; a
 * máquina de status (RN-RISK-15) é a função única usada pela API ao gravar e pela UI ao oferecer as
 * opções do `TreatmentStatusSelect`.
 */

/** entities.md §2 — `TreatmentType`. */
export const TREATMENT_TYPES = ['PREVENTIVE', 'CONTINGENCY'] as const;
export type TreatmentType = (typeof TREATMENT_TYPES)[number];

/** entities.md §2 — `TreatmentStatus` (RN-RISK-15). */
export const TREATMENT_STATUSES = ['PLANNED', 'IN_PROGRESS', 'DONE', 'CANCELED'] as const;
export type TreatmentStatus = (typeof TREATMENT_STATUSES)[number];

export const TREATMENT_TYPE_LABELS: Readonly<Record<TreatmentType, string>> = Object.freeze({
  PREVENTIVE: 'Prevenção',
  CONTINGENCY: 'Contingência',
});

export const TREATMENT_STATUS_LABELS: Readonly<Record<TreatmentStatus, string>> = Object.freeze({
  PLANNED: 'Planejada',
  IN_PROGRESS: 'Em andamento',
  DONE: 'Concluída',
  CANCELED: 'Cancelada',
});

/** Limites dos campos (US-034 · "Campos" · V-02). */
export const TREATMENT_LIMITS = Object.freeze({
  descriptionMin: 10,
  descriptionMax: 1000,
  notesMax: 1000,
});

/** Mensagens da tabela de validações e dos casos de erro da US-034. */
export const TREATMENT_MESSAGES = Object.freeze({
  typeRequired: 'Informe o tipo.',
  descriptionRequired: 'Informe a descrição.',
  descriptionLength: 'A descrição deve ter entre 10 e 1.000 caracteres.',
  notesLength: 'As observações devem ter no máximo 1.000 caracteres.',
  dueDateInvalid: 'Informe uma data válida.',
  responsibleInvalid: 'Selecione um responsável válido.',
  statusInvalid: 'Selecione um status válido.',
  sortOrderInvalid: 'Informe uma posição válida.',
  invalidTransition: (from: TreatmentStatus, to: TreatmentStatus) =>
    `Não é possível mudar o status de ${TREATMENT_STATUS_LABELS[from]} para ${TREATMENT_STATUS_LABELS[to]}.`,
  locked: 'As ações de tratamento estão bloqueadas porque o Mapa de Riscos foi concluído.',
  permissionDenied: 'Você não tem permissão para gerenciar tratamentos deste risco.',
  versionConflict: 'Esta ação foi alterada por outra pessoa. Recarregue para ver a versão atual.',
  unavailable: 'Não foi possível salvar agora. Tente novamente em instantes.',
  notFound: 'Ação de tratamento não encontrada.',
});

// --- Status (RN-RISK-15) ------------------------------------------------------------------------

/**
 * RN-RISK-15: `PLANNED → IN_PROGRESS → DONE`; qualquer status não terminal pode ir para `CANCELED`;
 * `DONE` e `CANCELED` são terminais no MVP 1 (sem reabertura).
 */
const TREATMENT_TRANSITIONS: Readonly<Record<TreatmentStatus, readonly TreatmentStatus[]>> =
  Object.freeze({
    PLANNED: ['IN_PROGRESS', 'CANCELED'],
    IN_PROGRESS: ['DONE', 'CANCELED'],
    DONE: [],
    CANCELED: [],
  });

/** Transição permitida (manter o mesmo status não é transição — não muda nada). */
export function canChangeTreatmentStatus(from: TreatmentStatus, to: TreatmentStatus): boolean {
  return TREATMENT_TRANSITIONS[from].includes(to);
}

/** Próximos status a partir do atual (opções do `TreatmentStatusSelect`). */
export function nextTreatmentStatuses(from: TreatmentStatus): readonly TreatmentStatus[] {
  return TREATMENT_TRANSITIONS[from];
}

/** `DONE`/`CANCELED`: sem transições no MVP 1. */
export function isTerminalTreatmentStatus(status: TreatmentStatus): boolean {
  return TREATMENT_TRANSITIONS[status].length === 0;
}

// --- Corpos -------------------------------------------------------------------------------------

const typeSchema = z.enum(TREATMENT_TYPES, { error: TREATMENT_MESSAGES.typeRequired });
const descriptionSchema = z
  .string({
    error: (issue) =>
      issue.input === undefined
        ? TREATMENT_MESSAGES.descriptionRequired
        : TREATMENT_MESSAGES.descriptionLength,
  })
  .trim()
  .min(1, { error: TREATMENT_MESSAGES.descriptionRequired, abort: true })
  .min(TREATMENT_LIMITS.descriptionMin, { error: TREATMENT_MESSAGES.descriptionLength })
  .max(TREATMENT_LIMITS.descriptionMax, { error: TREATMENT_MESSAGES.descriptionLength });
const responsibleSchema = z.uuid({ error: TREATMENT_MESSAGES.responsibleInvalid }).nullish();
/** Sem restrição de passado (FA-03: a UI destaca "Atrasado"). */
const dueDateSchema = z.iso.date({ error: TREATMENT_MESSAGES.dueDateInvalid }).nullish();
const notesSchema = z
  .string()
  .trim()
  .max(TREATMENT_LIMITS.notesMax, { error: TREATMENT_MESSAGES.notesLength })
  .transform((value) => (value === '' ? null : value))
  .nullish();

/**
 * RSK-06 — corpo de `POST /risks/{id}/treatments` (RN-RISK-11/13). ESTRITO: `status` (sempre
 * `PLANNED` na criação), `completedAt` e `sortOrder` não entram (422 `NOT_ALLOWED`).
 */
export const createRiskTreatmentSchema = z
  .strictObject({
    type: typeSchema,
    description: descriptionSchema,
    responsibleId: responsibleSchema,
    responsibleDepartmentId: responsibleSchema,
    dueDate: dueDateSchema,
    notes: notesSchema,
  })
  .meta({ id: 'CreateRiskTreatmentRequest' });
export type CreateRiskTreatment = z.output<typeof createRiskTreatmentSchema>;
export type CreateRiskTreatmentInput = z.input<typeof createRiskTreatmentSchema>;

/**
 * RSK-07 — corpo de `PATCH /risk-treatments/{treatmentId}`: subconjunto ESTRITO de RSK-06 (`null`
 * limpa os opcionais), mais `status` (RN-RISK-15) e `sortOrder` (reordenação — FA-02).
 * `completedAt` é do sistema (RN-RISK-12).
 */
export const updateRiskTreatmentSchema = z
  .strictObject({
    type: typeSchema.optional(),
    description: descriptionSchema.optional(),
    responsibleId: responsibleSchema,
    responsibleDepartmentId: responsibleSchema,
    dueDate: dueDateSchema,
    notes: notesSchema,
    status: z.enum(TREATMENT_STATUSES, { error: TREATMENT_MESSAGES.statusInvalid }).optional(),
    sortOrder: z
      .int({ error: TREATMENT_MESSAGES.sortOrderInvalid })
      .min(0, { error: TREATMENT_MESSAGES.sortOrderInvalid })
      .max(10_000, { error: TREATMENT_MESSAGES.sortOrderInvalid })
      .optional(),
  })
  .meta({ id: 'UpdateRiskTreatmentRequest' });
export type UpdateRiskTreatment = z.output<typeof updateRiskTreatmentSchema>;
export type UpdateRiskTreatmentInput = z.input<typeof updateRiskTreatmentSchema>;

/** Campos editáveis, na ordem canônica do diff e da auditoria. */
export const TREATMENT_FIELDS = [
  'type',
  'description',
  'responsibleId',
  'responsibleDepartmentId',
  'dueDate',
  'notes',
  'status',
  'sortOrder',
] as const;
export type TreatmentField = (typeof TREATMENT_FIELDS)[number];

export const riskTreatmentIdParamsSchema = z.strictObject({ treatmentId: uuidV7Schema });

// --- Resposta -----------------------------------------------------------------------------------

const namedRef = z.object({ id: z.uuid(), name: z.string() });

/** `RiskTreatment` — resposta de RSK-06/07 e item de `Risk.treatments` (RSK-01/03). */
export const riskTreatmentSchema = z
  .object({
    id: z.uuid(),
    riskId: z.uuid(),
    processId: z.uuid(),
    type: z.enum(TREATMENT_TYPES),
    description: z.string(),
    responsibleId: z.uuid().nullable(),
    responsible: namedRef.nullable(),
    responsibleDepartmentId: z.uuid().nullable(),
    responsibleDepartment: namedRef.nullable(),
    /** `YYYY-MM-DD` (o "Atrasado" é calculado na UI — FA-03). */
    dueDate: z.iso.date().nullable(),
    status: z.enum(TREATMENT_STATUSES),
    /** Gerado pelo sistema ao concluir (RN-RISK-12). */
    completedAt: z.iso.datetime().nullable(),
    notes: z.string().nullable(),
    sortOrder: z.int(),
    /** `If-Match` de RSK-07/RSK-08. */
    version: z.int().min(1),
  })
  .meta({ id: 'RiskTreatment' });
export type RiskTreatmentDto = z.infer<typeof riskTreatmentSchema>;
