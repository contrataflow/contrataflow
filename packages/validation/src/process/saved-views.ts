import { z } from 'zod';

import { PROCESS_STATUSES } from './process-actions.js';
import {
  MONEY_PATTERN,
  PROCESS_LIST_MAX_VALUES,
  PROCESS_LIST_PARAM_KEYS,
  PROCESS_LIST_QUERY_LIMITS,
  STAGE_KEY_PATTERN,
  processListQueryShape,
  processListSortSchema,
  refineProcessListRanges,
} from './process-list.js';
import type { ProcessListParamKey } from './process-list.js';
import { PRIORITIES } from './process.js';
import { isoDateSchema } from '../common/dates.js';

/*
 * Visões salvas da lista de processos (US-003 · PRC-35..38 · RN-PROC-34..39): critérios (filtros
 * de PRC-01 SEM paginação, ordenação e colunas) guardados por dono e escopo. `filters` é JSON
 * versionado (`{ "v": 1, … }`) já interpretado — listas, booleanos e anos numéricos —, validado
 * por `savedViewFiltersSchema`; mudanças futuras no contrato de filtros entram como upcaster em
 * `upcastSavedViewFilters`. As conversões URL ⇄ `filters` ficam aqui para a API e a tela usarem
 * exatamente a mesma regra.
 */

export const SAVED_VIEW_SCOPES = ['PROCESS_LIST', 'INBOX'] as const;
export type SavedViewScope = (typeof SAVED_VIEW_SCOPES)[number];

/** RN-PROC-34: nome de 1 a 80 caracteres após trim. */
export const SAVED_VIEW_NAME_MAX = 80;
/** RN-PROC-35: `sort` na sintaxe de RN-PROC-27, até 120 caracteres. */
export const SAVED_VIEW_SORT_MAX = 120;
/** RN-PROC-38: visões por dono e escopo. */
export const SAVED_VIEW_LIMIT = 20;
/** Versão atual do contrato de `filters`. */
export const SAVED_VIEW_FILTERS_VERSION = 1;

/** Mensagens da tabela "Validações"/"Casos de erro" da US-003, compartilhadas com a tela. */
export const SAVED_VIEW_MESSAGES = Object.freeze({
  invalid: 'Revise os dados da visão.',
  name: 'Informe um nome de até 80 caracteres.',
  nameTaken: 'Você já tem uma visão com este nome.',
  invalidFilters: 'Não foi possível salvar: há filtros inválidos.',
  invalidColumns: 'Selecione colunas válidas.',
  invalidSort: 'Ordenação inválida.',
  limitReached: `Você atingiu o limite de ${SAVED_VIEW_LIMIT} visões. Exclua uma visão para salvar outra.`,
  sharedDefault: 'Salve uma cópia da visão para usá-la como padrão.',
  notOwner: 'Somente quem criou a visão pode alterá-la.',
  notFound: 'Visão não encontrada.',
  versionConflict: 'Esta visão foi alterada em outra janela.',
  preconditionRequired: 'Recarregue a visão e tente novamente.',
  forbidden: 'Você não tem acesso às visões desta lista.',
  staleFilters: 'Alguns filtros desta visão não estão mais disponíveis e foram ignorados.',
});

// --- Colunas -------------------------------------------------------------------------------

/** Chaves de coluna da lista e da exportação (US-003 · "Campos"). */
export const PROCESS_COLUMN_KEYS = [
  'code',
  'title',
  'status',
  'stage',
  'currentDepartment',
  'currentResponsible',
  'deadline',
  'priority',
  'requestingSecretariat',
  'requestingDepartment',
  'organization',
  'contractingType',
  'modality',
  'origin',
  'estimatedValue',
  'targetDate',
  'tags',
  'internalCode',
  'createdAt',
  'updatedAt',
] as const;
export type ProcessColumnKey = (typeof PROCESS_COLUMN_KEYS)[number];

/** Colunas sempre presentes (V-04). */
export const PROCESS_FIXED_COLUMNS: readonly ProcessColumnKey[] = ['code', 'title'];

/** Colunas visíveis por padrão na lista (US-002) — padrão de PRC-34 sem `columns`. */
export const PROCESS_DEFAULT_COLUMNS: readonly ProcessColumnKey[] = [
  'code',
  'title',
  'status',
  'stage',
  'currentDepartment',
  'currentResponsible',
  'deadline',
  'priority',
];

const columnKey = z.enum(PROCESS_COLUMN_KEYS, { error: SAVED_VIEW_MESSAGES.invalidColumns });

/** V-04: lista ordenada de chaves válidas, sem repetição, com `code` e `title`. */
export const processColumnsSchema = z
  .array(columnKey)
  .max(PROCESS_COLUMN_KEYS.length, { error: SAVED_VIEW_MESSAGES.invalidColumns })
  .superRefine((columns, context) => {
    const unique = new Set(columns).size === columns.length;
    const fixed = PROCESS_FIXED_COLUMNS.every((column) => columns.includes(column));
    if (!unique || !fixed) {
      context.addIssue({ code: 'custom', message: SAVED_VIEW_MESSAGES.invalidColumns });
    }
  });

// --- Filtros (`v: 1`) ----------------------------------------------------------------------

const F = SAVED_VIEW_MESSAGES.invalidFilters;

const list = <T extends z.ZodType>(item: T) =>
  z.array(item).min(1, { error: F }).max(PROCESS_LIST_MAX_VALUES, { error: F }).optional();
const uuid = z.uuid({ error: F });
const uuidOr = <const R extends readonly [string, ...string[]]>(...reserved: R) =>
  z.union([z.enum(reserved), uuid], { error: F });

const filtersShape = {
  v: z.literal(SAVED_VIEW_FILTERS_VERSION, { error: F }),
  q: z
    .string()
    .trim()
    .min(PROCESS_LIST_QUERY_LIMITS.qMin, { error: F })
    .max(PROCESS_LIST_QUERY_LIMITS.qMax, { error: F })
    .optional(),
  status: list(z.enum(PROCESS_STATUSES, { error: F })),
  stageKey: list(z.string().regex(STAGE_KEY_PATTERN, { error: F })),
  currentWorkflowStageId: list(uuid),
  currentDepartmentId: list(uuidOr('mine')),
  requestingSecretariatId: list(uuid),
  requestingDepartmentId: list(uuid),
  organizationId: list(uuid),
  currentResponsibleId: list(uuidOr('me', 'none')),
  priority: list(z.enum(PRIORITIES, { error: F })),
  contractingTypeId: list(uuid),
  modalityId: list(uuidOr('none')),
  originId: list(uuid),
  year: list(z.int({ error: F }).min(2000, { error: F }).max(2100, { error: F })),
  tagId: list(uuid),
  overdue: z.boolean({ error: F }).optional(),
  targetDateOverdue: z.boolean({ error: F }).optional(),
  createdFrom: isoDateSchema.optional(),
  createdTo: isoDateSchema.optional(),
  targetDateFrom: isoDateSchema.optional(),
  targetDateTo: isoDateSchema.optional(),
  estimatedValueMin: z.string().regex(MONEY_PATTERN, { error: F }).optional(),
  estimatedValueMax: z.string().regex(MONEY_PATTERN, { error: F }).optional(),
};

/** Filtros guardados (RN-PROC-35 · V-03): estrito — filtro desconhecido ou sem versão = inválido. */
export const savedViewFiltersSchema = z
  .strictObject(filtersShape, { error: F })
  .superRefine(refineProcessListRanges)
  .meta({ id: 'SavedViewFilters' });
export type SavedViewFilters = z.infer<typeof savedViewFiltersSchema>;
export type SavedViewFilterKey = Exclude<keyof typeof filtersShape, 'v'>;

/** Parâmetros de PRC-01 que não são filtros (nunca entram em `filters`). */
const NON_FILTER_PARAMS: ReadonlySet<ProcessListParamKey> = new Set([
  'page',
  'pageSize',
  'sort',
  'includeStageOptions',
]);

/** Filtros, na ordem da tabela "Campos" da US-002. */
export const SAVED_VIEW_FILTER_KEYS = PROCESS_LIST_PARAM_KEYS.filter(
  (key) => !NON_FILTER_PARAMS.has(key),
) as readonly SavedViewFilterKey[];

/**
 * Upcaster (US-003 · "Impacto técnico"): `filters` gravados em qualquer versão → forma atual, ou
 * `null` quando o JSON não é um filtro reconhecível. Hoje só existe `v: 1`.
 */
export function upcastSavedViewFilters(raw: unknown): SavedViewFilters | null {
  const parsed = savedViewFiltersSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Estado da lista (parâmetros crus da URL, já validados) → `filters` da visão. Paginação e
 * ordenação ficam de fora (a ordenação vai em `sort`).
 */
export function savedViewFiltersFromParams(
  params: Readonly<Partial<Record<ProcessListParamKey, string>>>,
): SavedViewFilters {
  const filters: Record<string, unknown> = { v: SAVED_VIEW_FILTERS_VERSION };
  for (const key of SAVED_VIEW_FILTER_KEYS) {
    const raw = params[key];
    if (raw === undefined || raw === '') continue;
    const parsed = processListQueryShape[key].safeParse(raw);
    if (parsed.success && parsed.data !== undefined) filters[key] = parsed.data;
  }
  return filters as SavedViewFilters;
}

/** `filters` da visão → parâmetros crus da URL (listas por vírgula, booleanos `true`/`false`). */
export function paramsFromSavedViewFilters(
  filters: SavedViewFilters,
): Partial<Record<SavedViewFilterKey, string>> {
  const params: Partial<Record<SavedViewFilterKey, string>> = {};
  for (const key of SAVED_VIEW_FILTER_KEYS) {
    const value = filters[key] as readonly (string | number)[] | string | boolean | undefined;
    if (value === undefined) continue;
    params[key] = typeof value === 'object' ? value.join(',') : String(value);
  }
  return params;
}

// --- Contratos de PRC-35..38 ---------------------------------------------------------------

const nameSchema = z
  .string({ error: SAVED_VIEW_MESSAGES.name })
  .trim()
  .min(1, { error: SAVED_VIEW_MESSAGES.name })
  .max(SAVED_VIEW_NAME_MAX, { error: SAVED_VIEW_MESSAGES.name });

/** RN-PROC-35: ordenação de RN-PROC-27 guardada como texto (`-priority,code`). */
export const savedViewSortSchema = z
  .string({ error: SAVED_VIEW_MESSAGES.invalidSort })
  .trim()
  .max(SAVED_VIEW_SORT_MAX, { error: SAVED_VIEW_MESSAGES.invalidSort })
  .refine((value) => processListSortSchema.safeParse(value).success, {
    error: SAVED_VIEW_MESSAGES.invalidSort,
  });

export const savedViewScopeSchema = z.enum(SAVED_VIEW_SCOPES, {
  error: 'Informe um escopo válido.',
});

/** PRC-35 (query). */
export const savedViewListQuerySchema = z
  .object({ scope: savedViewScopeSchema })
  .meta({ id: 'SavedViewListQuery' });
export type SavedViewListQuery = z.infer<typeof savedViewListQuerySchema>;

export const savedViewIdParamsSchema = z.object({ id: z.uuid() });

/** PRC-36 (corpo) — `Idempotency-Key` obrigatório. */
export const createSavedViewSchema = z
  .strictObject({
    scope: savedViewScopeSchema,
    name: nameSchema,
    filters: savedViewFiltersSchema,
    sort: savedViewSortSchema.nullable().optional(),
    columns: processColumnsSchema,
    isShared: z.boolean().optional().default(false),
    isDefault: z.boolean().optional().default(false),
  })
  .meta({ id: 'CreateSavedView' });
export type CreateSavedView = z.output<typeof createSavedViewSchema>;

/** PRC-37 (corpo) — subconjunto de PRC-36 (o escopo não muda) com `If-Match`. */
export const updateSavedViewSchema = z
  .strictObject({
    name: nameSchema.optional(),
    filters: savedViewFiltersSchema.optional(),
    sort: savedViewSortSchema.nullable().optional(),
    columns: processColumnsSchema.optional(),
    isShared: z.boolean().optional(),
    isDefault: z.boolean().optional(),
  })
  .meta({ id: 'UpdateSavedView' });
export type UpdateSavedView = z.output<typeof updateSavedViewSchema>;

/** `SavedView` de PRC-35..37. */
export const savedViewSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    scope: z.enum(SAVED_VIEW_SCOPES),
    filters: savedViewFiltersSchema,
    sort: z.string().nullable(),
    columns: z.array(z.enum(PROCESS_COLUMN_KEYS)),
    isShared: z.boolean(),
    isDefault: z.boolean(),
    owner: z.object({ id: z.uuid(), name: z.string() }),
    isOwner: z.boolean(),
    version: z.int(),
  })
  .meta({ id: 'SavedView' });
export type SavedViewDto = z.infer<typeof savedViewSchema>;
