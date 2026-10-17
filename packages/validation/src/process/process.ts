import { z } from 'zod';

import { PROCESS_STATUSES } from './process-actions.js';
import { isoDateSchema, isoDateTimeSchema } from '../common/dates.js';

/*
 * Processo de contratação (US-001 · entities.md §4.4 `Process` · api/02-processes.md PRC-02/03/04).
 * Os MESMOS schemas validam o wizard SCR-005 (passo a passo) e o corpo da API (V-01..V-09). As
 * regras que dependem do relógio e do fuso do tenant (prazo alvo ≥ hoje, exercício do PCA corrente
 * ou seguinte — RN-PROC-11/12) ficam em `processDateIssues`, chamada pelo domínio da API com a data
 * do tenant e pelo front com a data local.
 */

/** entities.md §2 — `Priority`. */
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** entities.md §2 — `PcaStatus` (DEC-029). */
export const PCA_STATUSES = ['PLANNED', 'NOT_PLANNED', 'NOT_APPLICABLE'] as const;
export type PcaStatus = (typeof PCA_STATUSES)[number];

/** entities.md §2 — `EstimatedValueSource` (DEC-032: precedência das fontes do valor estimado). */
export const ESTIMATED_VALUE_SOURCES = ['MANUAL', 'DFD', 'ETP', 'PRICE_RESEARCH', 'TERM'] as const;
export type EstimatedValueSource = (typeof ESTIMATED_VALUE_SOURCES)[number];

/** entities.md §2 — `CreationChannel`. */
export const CREATION_CHANNELS = ['WEB', 'DUPLICATION', 'IMPORT', 'API'] as const;
export type CreationChannel = (typeof CREATION_CHANNELS)[number];

/** Limites dos campos (US-001 · "Campos"). */
export const PROCESS_LIMITS = Object.freeze({
  titleMin: 5,
  titleMax: 200,
  objectMin: 10,
  objectMax: 2000,
  descriptionMax: 10_000,
  notesMax: 5000,
  pcaItemCodeMax: 60,
  pcaJustificationMin: 20,
  pcaJustificationMax: 10_000,
  internalCodeMax: 60,
});

/** Mensagens da tabela de validações da US-001 (V-01..V-12), compartilhadas com o wizard. */
export const PROCESS_MESSAGES = Object.freeze({
  titleRequired: 'Informe o título.',
  titleLength: `O título deve ter entre ${PROCESS_LIMITS.titleMin} e ${PROCESS_LIMITS.titleMax} caracteres.`,
  titleLineBreak: 'O título não pode ter quebras de linha.',
  objectRequired: 'Informe o objeto.',
  objectLength: `O objeto deve ter entre ${PROCESS_LIMITS.objectMin} e ${PROCESS_LIMITS.objectMax} caracteres.`,
  descriptionLength: 'A descrição deve ter no máximo 10.000 caracteres.',
  notesLength: 'As observações devem ter no máximo 5.000 caracteres.',
  contractingTypeRequired: 'Informe o tipo de contratação.',
  modalityInvalid: 'Selecione uma modalidade válida.',
  organizationInvalid: 'Selecione um órgão válido.',
  secretariatRequired: 'Informe a secretaria solicitante.',
  departmentRequired: 'Informe o setor solicitante.',
  priorityRequired: 'Informe a prioridade.',
  originRequired: 'Informe a origem.',
  pcaStatusRequired: 'Informe a situação no PCA.',
  pcaYearRequired: 'Informe o exercício do PCA.',
  pcaYearRange: 'O exercício do PCA deve ser o ano corrente ou o seguinte.',
  pcaItemCodeLength: 'O item do PCA deve ter no máximo 60 caracteres.',
  pcaJustificationRequired:
    'Justifique por que a contratação não está prevista no PCA (mín. 20 caracteres).',
  targetDateInvalid: 'Informe a data no formato AAAA-MM-DD.',
  targetDatePast: 'O prazo alvo não pode ser anterior a hoje.',
  estimatedValueInvalid: 'Informe um valor válido, com até 2 casas decimais.',
  internalCodeRequired: 'Informe o código interno.',
  internalCodeLength: 'O código interno deve ter no máximo 60 caracteres.',
  invalidReference: 'Selecione uma opção válida.',
  invalidUnit: 'Selecione uma unidade válida.',
  departmentNotInSecretariat: 'O setor deve pertencer à secretaria selecionada.',
  secretariatNotAllowed: 'Selecione uma secretaria válida.',
});

const LINE_BREAK = /[\r\n]/;
/** `Decimal(18,2)` sem sinal: até 16 dígitos inteiros e 2 casas (mesma forma do `moneySchema`). */
const MONEY_PATTERN = /^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/;

/**
 * Texto obrigatório com mensagem própria para ausente/vazio (`REQUIRED`) e outra para o tamanho
 * (`TOO_SHORT`/`TOO_LONG`) — um único erro por campo.
 */
function requiredText(options: {
  readonly min: number;
  readonly max: number;
  readonly required: string;
  readonly length: string;
}) {
  return z
    .string({ error: options.required })
    .trim()
    .min(options.min, {
      error: (issue) => (issue.input === '' ? options.required : options.length),
    })
    .max(options.max, { error: options.length });
}

function optionalText(max: number, message: string) {
  return z.string().trim().max(max, { error: message }).nullish();
}

function reference(required: string) {
  return z.uuid({ error: required });
}

/** Valor estimado `Decimal(18,2)` ≥ 0 trafegado como string (RN-PROC-10 · V-08). */
export const estimatedValueSchema = z
  .string({ error: PROCESS_MESSAGES.estimatedValueInvalid })
  .regex(MONEY_PATTERN, { error: PROCESS_MESSAGES.estimatedValueInvalid })
  .meta({ description: 'Decimal ≥ 0 com até 2 casas, ponto como separador (ex.: "15000.00").' });

export const processTitleSchema = requiredText({
  min: PROCESS_LIMITS.titleMin,
  max: PROCESS_LIMITS.titleMax,
  required: PROCESS_MESSAGES.titleRequired,
  length: PROCESS_MESSAGES.titleLength,
}).refine((value) => !LINE_BREAK.test(value), {
  error: PROCESS_MESSAGES.titleLineBreak,
  params: { code: 'INVALID_FORMAT' },
});

export const processObjectSchema = requiredText({
  min: PROCESS_LIMITS.objectMin,
  max: PROCESS_LIMITS.objectMax,
  required: PROCESS_MESSAGES.objectRequired,
  length: PROCESS_MESSAGES.objectLength,
});

const prioritySchema = z
  .string({ error: PROCESS_MESSAGES.priorityRequired })
  .pipe(z.enum(PRIORITIES, { error: PROCESS_MESSAGES.priorityRequired }))
  .meta({ enum: [...PRIORITIES] });

const pcaStatusSchema = z
  .string({ error: PROCESS_MESSAGES.pcaStatusRequired })
  .pipe(z.enum(PCA_STATUSES, { error: PROCESS_MESSAGES.pcaStatusRequired }))
  .meta({ enum: [...PCA_STATUSES] });

/** Campos do PRC-02 (US-001 · "Campos"), sem as regras cruzadas. */
const createProcessShape = {
  title: processTitleSchema,
  object: processObjectSchema,
  description: optionalText(PROCESS_LIMITS.descriptionMax, PROCESS_MESSAGES.descriptionLength),
  contractingTypeId: reference(PROCESS_MESSAGES.contractingTypeRequired),
  /** Vazio/nulo = "A definir". */
  modalityId: z.uuid({ error: PROCESS_MESSAGES.modalityInvalid }).nullish(),
  isPriceRegistration: z.boolean().default(false),
  /** Ausente = órgão principal do tenant (RN-PROC-01). */
  organizationId: z.uuid({ error: PROCESS_MESSAGES.organizationInvalid }).optional(),
  requestingSecretariatId: reference(PROCESS_MESSAGES.secretariatRequired),
  requestingDepartmentId: reference(PROCESS_MESSAGES.departmentRequired),
  priority: prioritySchema.default('MEDIUM'),
  targetDate: isoDateSchema.nullish(),
  estimatedValue: estimatedValueSchema.nullish(),
  originId: reference(PROCESS_MESSAGES.originRequired),
  pcaStatus: pcaStatusSchema,
  pcaYear: z
    .int({ error: PROCESS_MESSAGES.pcaYearRange })
    .min(2000, { error: PROCESS_MESSAGES.pcaYearRange })
    .max(2100, { error: PROCESS_MESSAGES.pcaYearRange })
    .nullish(),
  pcaItemCode: optionalText(PROCESS_LIMITS.pcaItemCodeMax, PROCESS_MESSAGES.pcaItemCodeLength),
  pcaJustification: optionalText(
    PROCESS_LIMITS.pcaJustificationMax,
    PROCESS_MESSAGES.pcaJustificationRequired,
  ),
  internalCode: optionalText(PROCESS_LIMITS.internalCodeMax, PROCESS_MESSAGES.internalCodeLength),
  notes: optionalText(PROCESS_LIMITS.notesMax, PROCESS_MESSAGES.notesLength),
  /** Reenvio após o aviso de duplicidade (FA-02 · RN-PROC-13). */
  confirmDuplicate: z.boolean().default(false),
};

interface PcaFields {
  readonly pcaStatus?: PcaStatus | undefined;
  readonly pcaYear?: number | null | undefined;
  readonly pcaJustification?: string | null | undefined;
}

/** RN-PROC-12 (V-09): campos condicionais da situação no PCA. */
export function pcaIssues(
  value: PcaFields,
): { readonly path: 'pcaYear' | 'pcaJustification'; readonly message: string }[] {
  if (value.pcaStatus === 'PLANNED' && (value.pcaYear === undefined || value.pcaYear === null)) {
    return [{ path: 'pcaYear', message: PROCESS_MESSAGES.pcaYearRequired }];
  }
  if (value.pcaStatus === 'NOT_PLANNED') {
    const justification = value.pcaJustification?.trim() ?? '';
    if (justification.length < PROCESS_LIMITS.pcaJustificationMin) {
      return [{ path: 'pcaJustification', message: PROCESS_MESSAGES.pcaJustificationRequired }];
    }
  }
  return [];
}

/** PRC-02 — corpo de `POST /processes` (US-001 · api/02-processes.md). */
export const createProcessSchema = z
  .object(createProcessShape)
  .superRefine((value, ctx) => {
    for (const issue of pcaIssues(value)) {
      ctx.addIssue({
        code: 'custom',
        path: [issue.path],
        message: issue.message,
        params: { code: 'CONDITIONAL_REQUIRED' },
      });
    }
  })
  .meta({ id: 'CreateProcessRequest' });
export type CreateProcess = z.output<typeof createProcessSchema>;
export type CreateProcessInput = z.input<typeof createProcessSchema>;

/** Campos de cada passo do wizard SCR-005 (validação por passo antes de avançar). */
export const CREATE_PROCESS_STEP_FIELDS = Object.freeze({
  identification: [
    'title',
    'object',
    'description',
    'contractingTypeId',
    'modalityId',
    'isPriceRegistration',
  ],
  origin: [
    'organizationId',
    'requestingSecretariatId',
    'requestingDepartmentId',
    'priority',
    'targetDate',
    'estimatedValue',
    'originId',
    'pcaStatus',
    'pcaYear',
    'pcaItemCode',
    'pcaJustification',
  ],
  review: ['internalCode', 'notes'],
} as const satisfies Record<string, readonly (keyof typeof createProcessShape)[]>);

export interface ProcessDateContext {
  /** Hoje (`YYYY-MM-DD`) no fuso do tenant (API) ou local (front). */
  readonly today: string;
  /** Ano corrente no mesmo fuso. */
  readonly currentYear: number;
}

/**
 * RN-PROC-11 (V-07) e o exercício do PCA de RN-PROC-12: dependem do relógio, por isso ficam fora
 * do schema. Devolve um item por campo (vazio = válido).
 */
export function processDateIssues(
  value: {
    readonly targetDate?: string | null | undefined;
    readonly pcaStatus?: PcaStatus | undefined;
    readonly pcaYear?: number | null | undefined;
  },
  context: ProcessDateContext,
): { readonly path: 'targetDate' | 'pcaYear'; readonly message: string }[] {
  const issues: { path: 'targetDate' | 'pcaYear'; message: string }[] = [];
  if (value.targetDate && value.targetDate < context.today) {
    issues.push({ path: 'targetDate', message: PROCESS_MESSAGES.targetDatePast });
  }
  if (
    value.pcaStatus === 'PLANNED' &&
    typeof value.pcaYear === 'number' &&
    value.pcaYear !== context.currentYear &&
    value.pcaYear !== context.currentYear + 1
  ) {
    issues.push({ path: 'pcaYear', message: PROCESS_MESSAGES.pcaYearRange });
  }
  return issues;
}

/**
 * PRC-27 — corpo de `POST /processes/{id}/duplicate` (US-011 · api/02-processes.md): campos
 * omitidos copiam da origem; `title`/`object` seguem os limites do PRC-02. As cópias opcionais de
 * documentos estruturados (como rascunho) e de anexos (cópia lógica) nascem desligadas.
 */
export const duplicateProcessSchema = z
  .object({
    title: processTitleSchema.optional(),
    object: processObjectSchema.optional(),
    requestingSecretariatId: reference(PROCESS_MESSAGES.secretariatRequired).optional(),
    requestingDepartmentId: reference(PROCESS_MESSAGES.departmentRequired).optional(),
    copyDocuments: z.boolean().default(false),
    copyAttachments: z.boolean().default(false),
  })
  .meta({ id: 'DuplicateProcessRequest' });
export type DuplicateProcess = z.output<typeof duplicateProcessSchema>;
export type DuplicateProcessInput = z.input<typeof duplicateProcessSchema>;

/** PRC-03 — `POST /processes/check-duplicates` (mesmas regras de tamanho do PRC-02). */
export const checkDuplicateProcessesSchema = z
  .object({
    title: processTitleSchema,
    object: processObjectSchema,
    requestingDepartmentId: reference(PROCESS_MESSAGES.departmentRequired),
  })
  .meta({ id: 'CheckDuplicateProcessesRequest' });
export type CheckDuplicateProcesses = z.output<typeof checkDuplicateProcessesSchema>;

export const duplicateCandidateSchema = z
  .object({
    id: z.uuid(),
    code: z.string().nullable(),
    title: z.string(),
    status: z.enum(PROCESS_STATUSES),
    createdAt: isoDateTimeSchema,
    createdBy: z.object({ id: z.uuid(), name: z.string() }),
  })
  .meta({ id: 'DuplicateProcessCandidate' });
export type DuplicateCandidate = z.infer<typeof duplicateCandidateSchema>;

export const duplicateCheckResultSchema = z
  .object({ candidates: z.array(duplicateCandidateSchema) })
  .meta({ id: 'DuplicateCheckResult' });
export type DuplicateCheckResult = z.infer<typeof duplicateCheckResultSchema>;

const unitRefSchema = z.object({ id: z.uuid(), name: z.string() });
const catalogRefSchema = z.object({ id: z.uuid(), code: z.string(), label: z.string() });

/** `Process` — resposta de PRC-02/PRC-04 (api/02-processes.md, esquema de referência). */
export const processSchema = z
  .object({
    id: z.uuid(),
    code: z.string().nullable(),
    number: z.number().int().nullable(),
    year: z.number().int(),
    internalCode: z.string().nullable(),
    title: z.string(),
    object: z.string(),
    description: z.string().nullable(),
    status: z.enum(PROCESS_STATUSES),
    priority: z.enum(PRIORITIES),
    organization: z.object({ id: z.uuid(), shortName: z.string() }),
    requestingSecretariat: unitRefSchema,
    requestingDepartment: unitRefSchema,
    contractingType: catalogRefSchema,
    modality: catalogRefSchema.nullable(),
    origin: catalogRefSchema,
    isPriceRegistration: z.boolean(),
    currentStage: z
      .object({
        id: z.uuid(),
        key: z.string(),
        name: z.string(),
        dueAt: isoDateTimeSchema.nullable(),
        /** Orientação da etapa (Markdown) — "próximo passo" do painel situacional. */
        instructions: z.string().nullable(),
        /** Tipos de documento elaborados na etapa (ex.: `DFD` na abertura). */
        documentTypeCodes: z.array(z.string()),
      })
      .nullable(),
    currentDepartment: unitRefSchema,
    currentResponsible: unitRefSchema.nullable(),
    workflow: z.object({ id: z.uuid(), name: z.string(), versionNumber: z.number().int() }),
    targetDate: isoDateSchema.nullable(),
    /** `null` quando não informado ou mascarado (orçamento sigiloso — DEC-030). */
    estimatedValue: z.string().nullable(),
    estimatedValueMasked: z.boolean(),
    estimatedValueSource: z.enum(ESTIMATED_VALUE_SOURCES).nullable(),
    isBudgetConfidential: z.boolean(),
    pcaStatus: z.enum(PCA_STATUSES),
    pcaYear: z.number().int().nullable(),
    pcaItemCode: z.string().nullable(),
    pcaJustification: z.string().nullable(),
    notes: z.string().nullable(),
    creationChannel: z.enum(CREATION_CHANNELS),
    /** Processo de origem da duplicação (US-011 · RN-PROC-123); `null` fora dela. */
    duplicatedFromId: z.uuid().nullable(),
    openedAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    createdBy: unitRefSchema,
    version: z.number().int(),
  })
  .meta({ id: 'Process' });
export type ProcessDto = z.infer<typeof processSchema>;

/*
 * PRC-05 — edição dos dados do processo (US-005 · api/02-processes.md). PATCH parcial: só os
 * campos enviados mudam; schema ESTRITO (campo fora da lista → 422 `NOT_ALLOWED` — RN-PROC-65).
 * As regras que dependem do estado atual (bloqueio por status, fonte do valor estimado, regras
 * cruzadas do PCA, prazo alvo ≥ hoje) são do domínio da API, sobre o estado resultante
 * (RN-PROC-60..64); o front repete as mesmas sobre o formulário completo.
 */

/** RN-PROC-59: status em que o processo admite edição (POL-01). */
export const EDITABLE_PROCESS_STATUSES = ['DRAFT', 'IN_PROGRESS', 'RETURNED'] as const;

/** RN-PROC-60: só editáveis em `DRAFT` (órgão — com RN-PROC-61 — e unidade solicitante). */
export const DRAFT_ONLY_PROCESS_FIELDS = [
  'organizationId',
  'requestingSecretariatId',
  'requestingDepartmentId',
] as const;

/** Campos editáveis pelo PRC-05, na ordem canônica de `changedFields` (story · "Campos"). */
export const UPDATE_PROCESS_FIELDS = [
  ...DRAFT_ONLY_PROCESS_FIELDS,
  'title',
  'object',
  'description',
  'contractingTypeId',
  'modalityId',
  'isPriceRegistration',
  'priority',
  'targetDate',
  'estimatedValue',
  'originId',
  'pcaStatus',
  'pcaYear',
  'pcaItemCode',
  'pcaJustification',
  'internalCode',
  'notes',
] as const;
export type UpdatableProcessField = (typeof UPDATE_PROCESS_FIELDS)[number];

/** Nome das fontes do valor estimado nas mensagens (DEC-032 · RN-PROC-63). */
export const ESTIMATED_VALUE_SOURCE_LABELS: Readonly<Record<EstimatedValueSource, string>> =
  Object.freeze({
    MANUAL: 'Informado manualmente',
    DFD: 'DFD',
    ETP: 'ETP',
    PRICE_RESEARCH: 'Pesquisa de preços',
    TERM: 'Termo de referência',
  });

/** Mensagens da tabela de validações da US-005 (V-02, V-03, V-07, V-12 · FA-01..FA-08). */
export const PROCESS_UPDATE_MESSAGES = Object.freeze({
  lockedByStatus: 'Este campo só pode ser alterado enquanto o processo é rascunho.',
  lockedHint: 'Definido na abertura. Não pode ser alterado depois do primeiro encaminhamento.',
  lockedByNumbering: 'O órgão não pode ser alterado: o número do processo depende dele.',
  notEditable: 'Há campos que não podem ser alterados por aqui.',
  organizationNeedsUnits: 'Ao trocar o órgão, informe também a secretaria e o setor do novo órgão.',
  internalCodeRequired: 'O código interno é obrigatório neste órgão.',
  awaitingApproval: 'Não é possível editar enquanto o processo aguarda aprovação.',
  notCustodian: 'O processo saiu da sua responsabilidade. Suas alterações não foram salvas.',
  workflowUnchanged: 'O fluxo do processo não muda com esta alteração.',
  noChanges: 'Nenhuma alteração para salvar.',
  saved: 'Dados do processo atualizados',
});

/** V-07: "O valor estimado é obtido de {fonte}. Para alterá-lo, ajuste o documento de origem." */
export function estimatedValueFromSourceMessage(source: EstimatedValueSource): string {
  return `O valor estimado é obtido de ${ESTIMATED_VALUE_SOURCE_LABELS[source]}. Para alterá-lo, ajuste o documento de origem.`;
}

/** PRC-05 — corpo de `PATCH /processes/{id}`: subconjunto estrito dos campos editáveis. */
export const updateProcessSchema = z
  .strictObject({
    organizationId: z.uuid({ error: PROCESS_MESSAGES.organizationInvalid }).optional(),
    requestingSecretariatId: reference(PROCESS_MESSAGES.secretariatRequired).optional(),
    requestingDepartmentId: reference(PROCESS_MESSAGES.departmentRequired).optional(),
    title: processTitleSchema.optional(),
    object: processObjectSchema.optional(),
    description: createProcessShape.description,
    contractingTypeId: reference(PROCESS_MESSAGES.contractingTypeRequired).optional(),
    /** `null` = "A definir". */
    modalityId: createProcessShape.modalityId,
    isPriceRegistration: z.boolean().optional(),
    priority: prioritySchema.optional(),
    targetDate: isoDateSchema.nullish(),
    /** `null` limpa o valor manual (e a origem — RN-PROC-63). */
    estimatedValue: estimatedValueSchema.nullish(),
    originId: reference(PROCESS_MESSAGES.originRequired).optional(),
    pcaStatus: pcaStatusSchema.optional(),
    pcaYear: createProcessShape.pcaYear,
    pcaItemCode: createProcessShape.pcaItemCode,
    pcaJustification: createProcessShape.pcaJustification,
    internalCode: createProcessShape.internalCode,
    notes: createProcessShape.notes,
  })
  .meta({ id: 'UpdateProcessRequest' });
export type UpdateProcess = z.output<typeof updateProcessSchema>;
export type UpdateProcessInput = z.input<typeof updateProcessSchema>;

/**
 * `meta.current` do 412 `VERSION_CONFLICT` do PRC-05 (FA-05): o processo atual (mesmo
 * mascaramento do PRC-04) e quem fez a última alteração, para a reaplicação seletiva no front.
 */
export const processConflictCurrentSchema = processSchema
  .extend({ updatedBy: unitRefSchema.nullable() })
  .meta({ id: 'ProcessConflictCurrent' });
export type ProcessConflictCurrent = z.infer<typeof processConflictCurrentSchema>;
