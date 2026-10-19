import { z } from 'zod';

import { APPROVAL_SUBJECT_TYPES } from './events.js';
import { isoDateSchema, isoDateTimeSchema } from '../common/dates.js';
import { APPROVER_TYPES } from '../document/document-type.js';
import { pageMetaSchema, pageQuerySchema } from '../http/pagination.js';
import { APPROVAL_STATUSES } from '../process/process-actions.js';
import type { ApprovalStatus } from '../process/process-actions.js';

/*
 * Lista de aprovações (US-057 · APV-01 · SCR-014): as `Approval` da cobertura de aprovador do
 * usuário (POL-03 · RN-INBOX-14). O mesmo `approvalListQuerySchema` valida a query string na API
 * (422 `VALIDATION_ERROR`) e os filtros no front (V-02 antes de chamar a API); as mensagens são as
 * das tabelas "Validações" e "Casos de erro" da story.
 */

/** RN-INBOX-18: campos ordenáveis (lista fechada — nunca interpolados no SQL). */
export const APPROVAL_LIST_SORT_FIELDS = ['requestedAt', 'dueAt', 'code'] as const;
export type ApprovalListSortField = (typeof APPROVAL_LIST_SORT_FIELDS)[number];

export const APPROVAL_LIST_DEFAULT_SORT = '-requestedAt';
export const APPROVAL_LIST_DEFAULT_PAGE_SIZE = 20;
/** RN-INBOX-15: sem `status`, só as pendentes. */
export const APPROVAL_LIST_DEFAULT_STATUSES: readonly ApprovalStatus[] = ['PENDING'];
export const APPROVAL_LIST_QUERY_LIMITS = Object.freeze({ qMin: 2, qMax: 200 });

export const APPROVAL_LIST_MESSAGES = Object.freeze({
  invalidFilter: 'Revise os filtros selecionados.',
  invalidPeriod: 'O período informado é inválido.',
  invalidDepartment: 'Selecione uma unidade válida.',
  invalidSort: 'Ordenação inválida.',
  searchTooLong: 'A busca pode ter até 200 caracteres.',
  unavailable: 'Não foi possível carregar as aprovações agora.',
  rateLimited: 'Muitas tentativas. Aguarde alguns segundos.',
});

export interface ApprovalListSort {
  readonly field: ApprovalListSortField;
  readonly direction: 'asc' | 'desc';
}

const SORT_TERM = new RegExp(`^(-?)(${APPROVAL_LIST_SORT_FIELDS.join('|')})$`);

/** `-campo` = decrescente; `null` = fora do formato ou campo não permitido (RN-INBOX-18). */
export function parseApprovalListSort(value: string): ApprovalListSort | null {
  const match = SORT_TERM.exec(value);
  if (!match) return null;
  return {
    field: match[2] as ApprovalListSortField,
    direction: match[1] === '-' ? 'desc' : 'asc',
  };
}

export function formatApprovalListSort(sort: ApprovalListSort): string {
  return `${sort.direction === 'desc' ? '-' : ''}${sort.field}`;
}

/** `status` múltiplo (§1.2 de api.md): repetição ou vírgula, OU entre os valores; vazio = padrão. */
const statusParam = z
  .union([z.string(), z.array(z.string())])
  .transform((value) =>
    (Array.isArray(value) ? value.join(',') : value)
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== ''),
  )
  .pipe(z.array(z.enum(APPROVAL_STATUSES)).max(APPROVAL_STATUSES.length))
  .optional();

/** V-03: o front ignora a busca curta; a API recusa (o parâmetro nunca chega com menos de 2). */
const searchParam = z
  .string()
  .trim()
  .min(APPROVAL_LIST_QUERY_LIMITS.qMin)
  .max(APPROVAL_LIST_QUERY_LIMITS.qMax, { error: APPROVAL_LIST_MESSAGES.searchTooLong });

/** Filtros de APV-01 (sem paginação): os do front e os da API. */
export const approvalListFiltersShape = {
  status: statusParam,
  subjectType: z.enum(APPROVAL_SUBJECT_TYPES).optional(),
  requestingDepartmentId: z.uuid({ error: APPROVAL_LIST_MESSAGES.invalidDepartment }).optional(),
  requestedFrom: isoDateSchema.optional(),
  requestedTo: isoDateSchema.optional(),
  q: searchParam.optional(),
};

/** V-02: `requestedFrom` ≤ `requestedTo` (datas `YYYY-MM-DD` comparáveis como texto). */
export function isApprovalPeriodValid(from: string | undefined, to: string | undefined): boolean {
  return from === undefined || to === undefined || from === '' || to === '' || from <= to;
}

/** APV-01 — `?status=&subjectType=&requestingDepartmentId=&requestedFrom=&requestedTo=&q=&…`. */
export const approvalListQuerySchema = pageQuerySchema
  .extend({
    ...approvalListFiltersShape,
    sort: z.string().max(40).default(APPROVAL_LIST_DEFAULT_SORT),
  })
  .transform((query, context) => {
    const sort = parseApprovalListSort(query.sort);
    if (sort === null) {
      context.addIssue({
        code: 'custom',
        path: ['sort'],
        message: APPROVAL_LIST_MESSAGES.invalidSort,
        params: { code: 'INVALID_ENUM' },
      });
    }
    if (!isApprovalPeriodValid(query.requestedFrom, query.requestedTo)) {
      context.addIssue({
        code: 'custom',
        path: ['requestedTo'],
        message: APPROVAL_LIST_MESSAGES.invalidPeriod,
      });
    }
    if (sort === null || !isApprovalPeriodValid(query.requestedFrom, query.requestedTo)) {
      return z.NEVER;
    }
    const statuses =
      query.status === undefined || query.status.length === 0
        ? [...APPROVAL_LIST_DEFAULT_STATUSES]
        : [...new Set(query.status)];
    return {
      statuses,
      subjectType: query.subjectType ?? null,
      requestingDepartmentId: query.requestingDepartmentId ?? null,
      requestedFrom: query.requestedFrom ?? null,
      requestedTo: query.requestedTo ?? null,
      q: query.q ?? null,
      sort,
      page: query.page,
      pageSize: query.pageSize,
    };
  })
  .meta({ id: 'ApprovalListQuery' });
export type ApprovalListQuery = z.output<typeof approvalListQuerySchema>;

const refSchema = z.object({ id: z.uuid(), name: z.string() });

/** Linha de APV-01. Sem valores monetários (FA-04). */
export const approvalListItemSchema = z
  .object({
    id: z.uuid(),
    subjectType: z.enum(APPROVAL_SUBJECT_TYPES),
    /** Título da aprovação ("Aprovação do DFD", o documento avulso…). */
    title: z.string(),
    status: z.enum(APPROVAL_STATUSES),
    process: z.object({ id: z.uuid(), code: z.string().nullable(), title: z.string() }),
    /** Documento avulso (`subjectType = DOCUMENT`); `null` na aprovação de etapa. */
    document: z.object({ id: z.uuid() }).nullable(),
    /** Secretaria solicitante do processo. */
    requestingDepartment: refSchema,
    requestedBy: refSchema,
    requestedAt: isoDateTimeSchema,
    dueAt: isoDateTimeSchema.nullable(),
    /** RN-INBOX-16: `dueAt` anterior a agora, só enquanto pendente. */
    isOverdue: z.boolean(),
    /** FA-02: no perfil, "Aguardando: qualquer titular de {perfil}". */
    approver: z.object({ type: z.enum(APPROVER_TYPES), label: z.string() }),
    isBudgetConfidential: z.boolean(),
  })
  .meta({ id: 'ApprovalListItem' });
export type ApprovalListItemDto = z.infer<typeof approvalListItemSchema>;

export const approvalListResponseSchema = z.object({
  data: z.array(approvalListItemSchema),
  meta: pageMetaSchema,
});
export type ApprovalListResponse = z.infer<typeof approvalListResponseSchema>;
