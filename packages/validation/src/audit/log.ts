import { ACTOR_TYPES, AUDIT_CATEGORIES, AUDIT_RESULTS, isAuditAction } from '@contrataflow/types';
import type { AuditAction, AuditCategory, AuditResult } from '@contrataflow/types';
import { z } from 'zod';

import { isoDateTimeSchema } from '../common/dates.js';
import { MAX_PAGE_SIZE, cursorMetaSchema } from '../http/pagination.js';

/*
 * Consulta e exportação da trilha de auditoria (US-075 · AUD-01/02/03 · SCR-037 aba "Registros"):
 * período obrigatório de até 90 dias (RN-AUD-17), filtros combináveis (E entre parâmetros, OU por
 * vírgula dentro do mesmo — api.md §1.2), paginação por cursor e o formato da exportação
 * (RN-AUD-19). O mesmo schema valida a API (422) e o painel de filtros do front.
 */

/** Mensagens das tabelas "Validações" e "Casos de erro" da US-075, compartilhadas com a tela. */
export const AUDIT_LOG_MESSAGES = Object.freeze({
  period: 'Selecione um período de até 90 dias.',
  periodRange: 'A data final deve ser posterior à inicial.',
  invalidFormat: 'Selecione um formato de exportação válido.',
  invalidCursor: 'Não foi possível continuar a listagem. Pesquise novamente.',
  notFound: 'Registro de auditoria não encontrado.',
  exportTooLarge: (count: number) =>
    `Muitos registros para exportar (${count.toLocaleString('pt-BR')}). Refine o período ou os filtros.`,
  unavailable: 'Não foi possível consultar a auditoria agora. Tente novamente em instantes.',
});

/** `audit.search.maxPeriodDays` (RN-AUD-17): garante a poda de partições mensais de `audit_logs`. */
export const AUDIT_SEARCH_MAX_PERIOD_DAYS = 90;

/** Padrão de `audit.export.maxRows` (RN-AUD-19); a API lê o valor efetivo da configuração. */
export const AUDIT_EXPORT_MAX_ROWS = 100_000;

/** Página padrão de AUD-01. */
export const AUDIT_LOG_PAGE_SIZE = 50;

/** Máximo de valores por filtro multivalorado (mesmo limite da timeline e da lista de processos). */
export const AUDIT_LOG_MAX_FILTER_VALUES = 50;

export const AUDIT_EXPORT_FORMATS = ['csv', 'ndjson'] as const;
export type AuditExportFormat = (typeof AUDIT_EXPORT_FORMATS)[number];

const DAY_MS = 86_400_000;

/** Período (ISO) dentro do teto: `occurredTo − occurredFrom ≤ 90 dias`. */
export function isAuditPeriodWithinLimit(occurredFrom: string, occurredTo: string): boolean {
  return Date.parse(occurredTo) - Date.parse(occurredFrom) <= AUDIT_SEARCH_MAX_PERIOD_DAYS * DAY_MS;
}

/** Período obrigatório: ausente → "Selecione um período de até 90 dias." (V-01). */
const periodBound = z.iso.datetime({
  error: (issue) =>
    issue.input === undefined
      ? AUDIT_LOG_MESSAGES.period
      : 'Informe data e hora no formato ISO 8601 em UTC (ex.: 2026-10-05T14:30:00Z).',
});

/** Valor de query string: texto com vírgulas ou repetição (`?action=a&action=b`), achatado. */
const rawValues = z.union([z.string(), z.array(z.string())]).transform((value) =>
  (Array.isArray(value) ? value.join(',') : value)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== ''),
);

/** Filtro multivalorado (OU): valores repetidos removidos; vazio = sem filtro. */
function multiFilter<T extends string>(isValid: (value: string) => boolean) {
  return rawValues
    .superRefine((values, context) => {
      if (values.some((value) => !isValid(value))) {
        context.addIssue({
          code: 'custom',
          message: 'Valor não permitido.',
          params: { code: 'INVALID_ENUM' },
        });
      }
      if (values.length > AUDIT_LOG_MAX_FILTER_VALUES) {
        context.addIssue({
          code: 'custom',
          message: `Selecione no máximo ${String(AUDIT_LOG_MAX_FILTER_VALUES)} opções por filtro.`,
          params: { code: 'OUT_OF_RANGE' },
        });
      }
    })
    .transform((values) => (values.length === 0 ? undefined : ([...new Set(values)] as T[])))
    .optional();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string) => UUID.test(value);
const inList = (list: readonly string[]) => (value: string) => list.includes(value);

/** Filtros de AUD-01 e AUD-03 (RN-AUD-17); o tenant é sempre o da sessão. */
const auditLogFilterShape = {
  occurredFrom: periodBound,
  occurredTo: periodBound,
  actorUserId: multiFilter<string>(isUuid),
  action: multiFilter<AuditAction>(isAuditAction),
  category: multiFilter<AuditCategory>(inList(AUDIT_CATEGORIES)),
  result: multiFilter<AuditResult>(inList(AUDIT_RESULTS)),
  entityType: z.string().trim().min(1).max(60).optional(),
  entityId: z.uuid().optional(),
  processId: z.uuid().optional(),
};

function checkPeriod(
  query: { readonly occurredFrom: string; readonly occurredTo: string },
  context: z.RefinementCtx,
): void {
  if (Date.parse(query.occurredTo) < Date.parse(query.occurredFrom)) {
    context.addIssue({
      code: 'custom',
      path: ['occurredTo'],
      message: AUDIT_LOG_MESSAGES.periodRange,
      params: { code: 'OUT_OF_RANGE' },
    });
    return;
  }
  if (!isAuditPeriodWithinLimit(query.occurredFrom, query.occurredTo)) {
    context.addIssue({
      code: 'custom',
      path: ['occurredTo'],
      message: AUDIT_LOG_MESSAGES.period,
      params: { code: 'OUT_OF_RANGE' },
    });
  }
}

/** `limit` 1..∞: acima de 100 a API ajusta para o máximo, sem erro (V-03). */
const limitSchema = z.coerce
  .number({ error: 'Informe um número inteiro em "limit".' })
  .int({ error: 'Informe um número inteiro em "limit".' })
  .min(1, { error: '"limit" deve ser maior ou igual a 1.' })
  .transform((value) => Math.min(value, MAX_PAGE_SIZE))
  .default(AUDIT_LOG_PAGE_SIZE);

/** AUD-01 (query): filtros + cursor opaco e `limit` (padrão 50, máximo 100). */
export const auditLogSearchQuerySchema = z
  .strictObject({
    ...auditLogFilterShape,
    cursor: z
      .string()
      .min(1, { error: 'Cursor inválido.' })
      .max(512, { error: 'Cursor inválido.' })
      .regex(/^[A-Za-z0-9_-]+$/, { error: 'Cursor inválido.' })
      .optional(),
    limit: limitSchema,
  })
  .superRefine(checkPeriod)
  .meta({ id: 'AuditLogSearchQuery' });
export type AuditLogSearchQuery = z.output<typeof auditLogSearchQuerySchema>;

/** AUD-03 (query): os mesmos filtros de AUD-01, sem paginação, e o formato (padrão `csv`). */
export const auditLogExportQuerySchema = z
  .strictObject({
    ...auditLogFilterShape,
    format: z
      .enum(AUDIT_EXPORT_FORMATS, { error: AUDIT_LOG_MESSAGES.invalidFormat })
      .default('csv'),
  })
  .superRefine(checkPeriod)
  .meta({ id: 'AuditLogExportQuery' });
export type AuditLogExportQuery = z.output<typeof auditLogExportQuerySchema>;

/** Filtros comuns a AUD-01 e AUD-03 (já validados). */
export type AuditLogFilters = Omit<AuditLogSearchQuery, 'cursor' | 'limit'>;

export const auditLogIdParamsSchema = z
  .strictObject({ id: z.uuid({ error: AUDIT_LOG_MESSAGES.notFound }) })
  .meta({ id: 'AuditLogIdParams' });

/** Campo alterado (RN-AUD-18): `old`/`new` já mascarados na gravação — nunca desmascarados. */
export const auditChangeSchema = z
  .object({
    path: z.string(),
    old: z.unknown(),
    new: z.unknown(),
  })
  .meta({ id: 'AuditChange' });
export type AuditChangeDto = z.infer<typeof auditChangeSchema>;

/** `AuditLog` (entities.md §4) devolvido por AUD-01/AUD-02 — o tenant é implícito (o da sessão). */
export const auditLogSchema = z
  .object({
    id: z.uuid(),
    occurredAt: isoDateTimeSchema,
    actorType: z.enum(ACTOR_TYPES),
    actorUserId: z.uuid().nullable(),
    /** Nome congelado do ator no momento do fato; `null` para `SYSTEM`. */
    actorName: z.string().nullable(),
    actorMembershipId: z.uuid().nullable(),
    onBehalfOfUserId: z.uuid().nullable(),
    /** Catálogo de events.md §7 (`resource.action`). */
    action: z.string(),
    category: z.enum(AUDIT_CATEGORIES),
    result: z.enum(AUDIT_RESULTS),
    entityType: z.string().nullable(),
    entityId: z.uuid().nullable(),
    processId: z.uuid().nullable(),
    changes: z.array(auditChangeSchema).nullable(),
    metadata: z.record(z.string(), z.unknown()),
    reasonCode: z.string().nullable(),
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
    correlationId: z.string().nullable(),
    requestId: z.string().nullable(),
    sessionIdHash: z.string().nullable(),
    /** SHA-256 da forma canônica do registro (RN-AUD-08) — base da selagem (US-074). */
    rowHash: z.string(),
  })
  .meta({ id: 'AuditLog' });
export type AuditLogDto = z.infer<typeof auditLogSchema>;

export const auditLogSearchResponseSchema = z.object({
  data: z.array(auditLogSchema),
  meta: cursorMetaSchema,
});
export type AuditLogSearchResponse = z.infer<typeof auditLogSearchResponseSchema>;

export const auditLogResponseSchema = z.object({ data: auditLogSchema });
export type AuditLogResponse = z.infer<typeof auditLogResponseSchema>;
