import { z } from 'zod';

import { PROCESS_STATUSES } from './process-actions.js';
import type { ProcessStatus } from './process-actions.js';
import { PRIORITIES } from './process.js';
import { isoDateSchema, isoDateTimeSchema } from '../common/dates.js';
import { DAY_COUNT_TYPES } from '../document/document-type.js';
import { MAX_PAGE_SIZE, pageMetaSchema } from '../http/pagination.js';

/*
 * Lista de processos (US-002 · PRC-01 · SCR-004): o CONTRATO DE FILTROS reutilizado pelas visões
 * salvas e pela exportação (US-003), pelos links do dashboard (US-076) e das notificações. O mesmo
 * `processListQuerySchema` valida a query string na API (422 `VALIDATION_ERROR`) e a URL no front
 * (`parseProcessListParams` descarta o inválido com aviso — FA-03). Vírgula = OU dentro do filtro;
 * filtros distintos = E (RN-PROC-20); parâmetros desconhecidos são ignorados.
 */

/** Máximo de valores por filtro multivalorado (V-08). */
export const PROCESS_LIST_MAX_VALUES = 50;
export const PROCESS_LIST_QUERY_LIMITS = Object.freeze({ qMin: 2, qMax: 200, maxSortFields: 3 });

/** RN-PROC-27: campos ordenáveis (lista fechada — nunca interpolados no SQL). */
export const PROCESS_LIST_SORT_FIELDS = [
  'updatedAt',
  'createdAt',
  'openedAt',
  'code',
  'title',
  'priority',
  'status',
  'currentStageDueAt',
  'targetDate',
  'estimatedValue',
] as const;
export type ProcessListSortField = (typeof PROCESS_LIST_SORT_FIELDS)[number];

export const PROCESS_LIST_DEFAULT_SORT = '-updatedAt';
export const PROCESS_LIST_DEFAULT_PAGE_SIZE = 20;

/** RN-PROC-30: "Em andamento" — padrão da tela sem parâmetros (a API sem filtro devolve todos). */
export const IN_PROGRESS_STATUSES: readonly ProcessStatus[] = [
  'DRAFT',
  'IN_PROGRESS',
  'AWAITING_APPROVAL',
  'RETURNED',
  'SUSPENDED',
];

/** RN-PROC-23: status em que o prazo da etapa pode estar vencido (`SUSPENDED` = prazo pausado). */
export const OVERDUE_ELIGIBLE_STATUSES: readonly ProcessStatus[] = [
  'DRAFT',
  'IN_PROGRESS',
  'AWAITING_APPROVAL',
  'RETURNED',
];

/** Status finais (DEC-013): nunca "atrasados" nem com prazo alvo vencido. */
export const FINAL_PROCESS_STATUSES: readonly ProcessStatus[] = [
  'CANCELED',
  'COMPLETED',
  'PUBLISHED',
];

/** Mensagens da tabela de validações da US-002 (V-01..V-09), compartilhadas com a tela. */
export const PROCESS_LIST_MESSAGES = Object.freeze({
  invalidFilters: 'Alguns filtros eram inválidos e foram ignorados.',
  invalidLink: 'Alguns filtros do link eram inválidos e foram ignorados.',
  invalidOption: 'Alguns filtros eram inválidos e foram ignorados.',
  searchLength: 'Digite ao menos 2 caracteres para buscar.',
  searchTooLong: 'Informe no máximo 200 caracteres na busca.',
  invalidPage: 'Página inválida.',
  invalidSort: 'Ordenação inválida.',
  dateRange: 'A data inicial deve ser anterior ou igual à final.',
  invalidDate: 'Informe a data no formato AAAA-MM-DD.',
  invalidValue: 'Informe valores válidos, com até 2 casas decimais.',
  tooManyValues: `Selecione no máximo ${PROCESS_LIST_MAX_VALUES} opções por filtro.`,
  invalidYear: 'Informe um ano válido.',
  invalidBoolean: 'Informe "true" ou "false".',
});

const M = PROCESS_LIST_MESSAGES;

/** `Decimal(18,2)` ≥ 0 com até 2 casas (mesma forma do `estimatedValueSchema`). */
export const MONEY_PATTERN = /^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/;
export const STAGE_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,59}$/;

/** Valor de query string: texto ou repetição (`?status=A&status=B`), achatado em uma lista. */
const rawValues = z.union([z.string(), z.array(z.string())]).transform((value) =>
  (Array.isArray(value) ? value.join(',') : value)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== ''),
);

/** Filtro multivalorado (OU): sem repetições, até 50 valores; vazio = ausente. */
function multi<T extends z.ZodType<string | number, string>>(item: T) {
  return rawValues
    .pipe(z.array(item).max(PROCESS_LIST_MAX_VALUES, { error: M.tooManyValues }))
    .transform((values) =>
      values.length === 0 ? undefined : [...new Set(values as z.output<T>[])],
    )
    .optional();
}

const uuid = z.uuid({ error: M.invalidOption });
const uuidOr = <const R extends readonly [string, ...string[]]>(...reserved: R) =>
  z.union([z.enum(reserved), uuid], { error: M.invalidOption });

const booleanParam = z
  .enum(['true', 'false'], { error: M.invalidBoolean })
  .transform((value) => value === 'true')
  .optional();

const yearItem = z
  .string()
  .regex(/^\d{4}$/, { error: M.invalidYear })
  .transform(Number)
  .pipe(z.int().min(2000, { error: M.invalidYear }).max(2100, { error: M.invalidYear }));

const pageInt = (max?: number) => {
  const base = z
    .string()
    .regex(/^\d+$/, { error: M.invalidPage })
    .transform(Number)
    .pipe(z.int().min(1, { error: M.invalidPage }));
  return max === undefined ? base : base.pipe(z.int().max(max, { error: M.invalidPage }));
};

const money = z.string().regex(MONEY_PATTERN, { error: M.invalidValue });

export interface ProcessListSortTerm {
  readonly field: ProcessListSortField;
  readonly direction: 'asc' | 'desc';
}

const SORT_TERM = new RegExp(`^(-?)(${PROCESS_LIST_SORT_FIELDS.join('|')})$`);

/** RN-PROC-27 · V-05: `-campo` = decrescente, até 3 campos, sem repetir campo. */
export const processListSortSchema = z.string().transform((value, context) => {
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const terms: ProcessListSortTerm[] = [];
  for (const part of parts) {
    const match = SORT_TERM.exec(part);
    if (!match || terms.some((term) => term.field === match[2])) {
      context.addIssue({ code: 'custom', message: M.invalidSort });
      return z.NEVER;
    }
    terms.push({
      field: match[2] as ProcessListSortField,
      direction: match[1] === '-' ? 'desc' : 'asc',
    });
  }
  if (terms.length === 0 || terms.length > PROCESS_LIST_QUERY_LIMITS.maxSortFields) {
    context.addIssue({ code: 'custom', message: M.invalidSort });
    return z.NEVER;
  }
  return terms;
});

/** Centavos de um decimal com até 2 casas (comparação exata, sem ponto flutuante). */
function cents(value: string): bigint {
  const [integer = '0', fraction = ''] = value.split('.');
  return BigInt(integer) * 100n + BigInt(fraction.padEnd(2, '0'));
}

/** Forma da query de PRC-01 (reutilizada pela exportação — PRC-34 · US-003). */
export const processListQueryShape = {
  page: pageInt().optional().default(1),
  pageSize: pageInt(MAX_PAGE_SIZE).optional().default(PROCESS_LIST_DEFAULT_PAGE_SIZE),
  sort: processListSortSchema.optional(),
  q: z
    .string()
    .trim()
    .min(PROCESS_LIST_QUERY_LIMITS.qMin, { error: M.searchLength })
    .max(PROCESS_LIST_QUERY_LIMITS.qMax, { error: M.searchTooLong })
    .optional(),
  status: multi(z.enum(PROCESS_STATUSES, { error: M.invalidOption })),
  stageKey: multi(z.string().regex(STAGE_KEY_PATTERN, { error: M.invalidOption })),
  currentWorkflowStageId: multi(uuid),
  currentDepartmentId: multi(uuidOr('mine')),
  requestingSecretariatId: multi(uuid),
  requestingDepartmentId: multi(uuid),
  organizationId: multi(uuid),
  currentResponsibleId: multi(uuidOr('me', 'none')),
  priority: multi(z.enum(PRIORITIES, { error: M.invalidOption })),
  contractingTypeId: multi(uuid),
  modalityId: multi(uuidOr('none')),
  originId: multi(uuid),
  year: multi(yearItem),
  tagId: multi(uuid),
  overdue: booleanParam,
  targetDateOverdue: booleanParam,
  createdFrom: isoDateSchema.optional(),
  createdTo: isoDateSchema.optional(),
  targetDateFrom: isoDateSchema.optional(),
  targetDateTo: isoDateSchema.optional(),
  estimatedValueMin: money.optional(),
  estimatedValueMax: money.optional(),
  includeStageOptions: booleanParam,
};

const queryShape = processListQueryShape;

/** Chaves aceitas na query string (as demais são ignoradas — RN-PROC-20). */
export const PROCESS_LIST_PARAM_KEYS = Object.keys(
  queryShape,
) as readonly (keyof typeof queryShape)[];
export type ProcessListParamKey = keyof typeof queryShape;

/** Intervalos "de/até" coerentes (V-06/V-07): datas e valores, onde quer que o filtro apareça. */
export function refineProcessListRanges(
  query: {
    readonly createdFrom?: string | undefined;
    readonly createdTo?: string | undefined;
    readonly targetDateFrom?: string | undefined;
    readonly targetDateTo?: string | undefined;
    readonly estimatedValueMin?: string | undefined;
    readonly estimatedValueMax?: string | undefined;
  },
  context: z.RefinementCtx,
): void {
  const range = (from: string | undefined, to: string | undefined, path: string) => {
    if (from !== undefined && to !== undefined && from > to) {
      context.addIssue({ code: 'custom', path: [path], message: M.dateRange });
    }
  };
  range(query.createdFrom, query.createdTo, 'createdTo');
  range(query.targetDateFrom, query.targetDateTo, 'targetDateTo');
  if (
    query.estimatedValueMin !== undefined &&
    query.estimatedValueMax !== undefined &&
    cents(query.estimatedValueMin) > cents(query.estimatedValueMax)
  ) {
    context.addIssue({ code: 'custom', path: ['estimatedValueMax'], message: M.invalidValue });
  }
}

/** PRC-01 (query) — filtros, busca, ordenação e paginação da tabela "Campos" da US-002. */
export const processListQuerySchema = z
  .object(queryShape)
  .superRefine(refineProcessListRanges)
  .meta({ id: 'ProcessListQuery' });
export type ProcessListQuery = z.output<typeof processListQuerySchema>;

/** Campos que formam um par "de/até" (o par inteiro cai se invertido). */
const RANGE_PAIRS: Readonly<Record<string, ProcessListParamKey>> = {
  createdTo: 'createdFrom',
  targetDateTo: 'targetDateFrom',
  estimatedValueMax: 'estimatedValueMin',
};

export interface ParsedProcessListParams {
  /** Parâmetros válidos, crus (como na URL), na ordem de `PROCESS_LIST_PARAM_KEYS`. */
  readonly params: Readonly<Partial<Record<ProcessListParamKey, string>>>;
  /** Parâmetros conhecidos descartados por inválidos (V-01..V-09). */
  readonly invalid: readonly ProcessListParamKey[];
}

/**
 * Front (SCR-004 · FA-03): valida cada parâmetro conhecido da URL com o mesmo schema da API e
 * descarta os inválidos (intervalo invertido descarta o par). Parâmetros desconhecidos somem.
 */
export function parseProcessListParams(
  input: Readonly<Record<string, string | undefined>>,
): ParsedProcessListParams {
  const params: Partial<Record<ProcessListParamKey, string>> = {};
  const invalid: ProcessListParamKey[] = [];
  for (const key of PROCESS_LIST_PARAM_KEYS) {
    const value = input[key];
    if (value === undefined) continue;
    if (queryShape[key].safeParse(value).success) params[key] = value;
    else invalid.push(key);
  }
  const whole = processListQuerySchema.safeParse(params);
  if (!whole.success) {
    for (const issue of whole.error.issues) {
      const key = issue.path[0] as ProcessListParamKey | undefined;
      if (key === undefined) continue;
      for (const dropped of [key, RANGE_PAIRS[key]]) {
        if (dropped !== undefined && dropped in params) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- chave da lista fechada
          delete params[dropped];
          invalid.push(dropped);
        }
      }
    }
  }
  return { params, invalid };
}

// --- Resposta ------------------------------------------------------------------------------

/** DTO calculado `deadline` (não persistido; reutilizado no painel situacional — US-004). */
export const processDeadlineSchema = z
  .object({
    /** `currentStageDueAt` (fim do dia no fuso do tenant). */
    dueAt: isoDateTimeSchema.nullable(),
    slaType: z.enum(DAY_COUNT_TYPES).nullable(),
    /** Dias até `dueAt` na unidade do `slaType` (0 = vence hoje); nulo sem prazo ou atrasado. */
    daysLeft: z.int().nullable(),
    /** Dias após `dueAt` (mesma unidade), contando hoje se for dia útil; nulo se não atrasado. */
    overdueDays: z.int().nullable(),
    /** Dias úteis restantes entre 0 e `deadlines.warnBeforeBusinessDays`. */
    isDueSoon: z.boolean(),
    /** RN-PROC-23. */
    isOverdue: z.boolean(),
    /** Etapa ativa com o prazo pausado (processo suspenso). */
    isPaused: z.boolean(),
  })
  .meta({ id: 'ProcessDeadline' });
export type ProcessDeadlineDto = z.infer<typeof processDeadlineSchema>;

const unitRefSchema = z.object({ id: z.uuid(), name: z.string() });
const catalogRefSchema = z.object({ id: z.uuid(), code: z.string(), label: z.string() });

/** `ProcessListItem` — subconjunto de `Process` + `deadline` (PRC-01). */
export const processListItemSchema = z
  .object({
    id: z.uuid(),
    code: z.string().nullable(),
    number: z.int().nullable(),
    year: z.int(),
    internalCode: z.string().nullable(),
    title: z.string(),
    status: z.enum(PROCESS_STATUSES),
    priority: z.enum(PRIORITIES),
    organization: z.object({ id: z.uuid(), shortName: z.string() }),
    requestingSecretariat: unitRefSchema,
    requestingDepartment: unitRefSchema,
    currentStage: z.object({ key: z.string(), name: z.string() }).nullable(),
    currentDepartment: unitRefSchema,
    currentResponsible: unitRefSchema.nullable(),
    deadline: processDeadlineSchema,
    contractingType: catalogRefSchema,
    modality: catalogRefSchema.nullable(),
    origin: catalogRefSchema,
    /** O fato do sigilo é público (RN-PROC-33); só o valor é mascarado. */
    isBudgetConfidential: z.boolean(),
    /** `null` quando não informado ou mascarado (POL-09 · RN-PROC-25). */
    estimatedValue: z.string().nullable(),
    estimatedValueMasked: z.boolean(),
    targetDate: isoDateSchema.nullable(),
    overdueSince: isoDateTimeSchema.nullable(),
    tags: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        color: z.string().nullable(),
        isActive: z.boolean(),
      }),
    ),
    openedAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .meta({ id: 'ProcessListItem' });
export type ProcessListItemDto = z.infer<typeof processListItemSchema>;

/** Opção do filtro "Etapa" (`includeStageOptions=true` — lacuna 1 da US-002). */
export const processStageOptionSchema = z
  .object({ key: z.string(), name: z.string(), groupLabel: z.string().nullable() })
  .meta({ id: 'ProcessStageOption' });
export type ProcessStageOptionDto = z.infer<typeof processStageOptionSchema>;

export const processListMetaSchema = pageMetaSchema
  .extend({
    stageOptions: z.array(processStageOptionSchema).optional(),
    /**
     * O filtro de valor exclui processos sigilosos que o usuário não pode ver (FA-05): a tela
     * exibe a nota sem indicar quais. Presente só com filtro de valor ativo.
     */
    valueFilterExcludesConfidential: z.boolean().optional(),
    /** Há valores mascarados que um step-up de MFA desmascararia (FA-12). */
    confidentialStepUpAvailable: z.boolean().optional(),
  })
  .meta({ id: 'ProcessListMeta' });
export type ProcessListMeta = z.infer<typeof processListMetaSchema>;

export const processListResponseSchema = z.object({
  data: z.array(processListItemSchema),
  meta: processListMetaSchema,
});
export type ProcessListResponse = z.infer<typeof processListResponseSchema>;
