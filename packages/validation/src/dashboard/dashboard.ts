import { z } from 'zod';

import { isoDateTimeSchema } from '../common/dates.js';
import { TASK_INBOX_VIEWS } from '../inbox/task-inbox.js';
import { PROCESS_STATUSES } from '../process/process-actions.js';
import type { ProcessStatus } from '../process/process-actions.js';
import { timelineEntrySchema } from '../process/timeline.js';

/*
 * Dashboard operacional por perfil (US-076 · DSH-01/DSH-02 · SCR-003): leituras agregadas sobre os
 * processos VISÍVEIS a quem consulta (DEC-024) — não é entidade. Os mesmos schemas validam a query
 * string na API (422 `VALIDATION_ERROR`) e as respostas no front; as mensagens são as das tabelas
 * "Validações" e "Casos de erro" da story.
 */

/** RN-DASH-02: registro `DashboardWidgetKey` (entities.md §2) — fora dele, 404 `WIDGET_NOT_FOUND`. */
export const DASHBOARD_WIDGET_KEYS = [
  'PENDING_ITEMS',
  'BY_STATUS',
  'BY_STAGE',
  'OVERDUE',
  'DUE_SOON',
  'AVG_STAGE_DURATION',
  'OPENED_BY_MONTH',
  'VALUE_BY_SECRETARIAT',
  'RECENT_ACTIVITY',
] as const;
export type DashboardWidgetKey = (typeof DASHBOARD_WIDGET_KEYS)[number];

export function isDashboardWidgetKey(value: string): value is DashboardWidgetKey {
  return (DASHBOARD_WIDGET_KEYS as readonly string[]).includes(value);
}

/** Polling do resumo (mesma cadência de TSK-02 — Fluxo principal, passo 7). */
export const DASHBOARD_POLL_INTERVAL_MS = 60_000;
/** RN-DASH-10: cache por `(tenant, usuário, indicador, filtros)`. */
export const DASHBOARD_CACHE_TTL_SECONDS = 60;
/** RN-DASH-05: janela fixa (não filtrável) do tempo médio por etapa. */
export const DASHBOARD_AVG_STAGE_WINDOW_DAYS = 90;
/** RN-DASH-06: meses da série de processos abertos (o mês corrente incluído). */
export const DASHBOARD_OPENED_MONTHS = 12;
/** RN-DASH-08 / V-04. */
export const DASHBOARD_RECENT_ACTIVITY_LIMITS = Object.freeze({ min: 1, max: 100, default: 20 });

/**
 * "Abertos" (`openCount`, `BY_STAGE`, `VALUE_BY_SECRETARIAT`): autuados e ainda não encerrados —
 * nem rascunho, nem cancelados, concluídos ou publicados.
 */
export const DASHBOARD_OPEN_STATUSES: readonly ProcessStatus[] = [
  'IN_PROGRESS',
  'AWAITING_APPROVAL',
  'RETURNED',
  'SUSPENDED',
];

/**
 * RN-DASH-04: status em que o prazo corre (`OVERDUE`/`DUE_SOON`) — o suspenso tem a etapa pausada
 * (sem contagem), como no DTO `deadline` (US-055).
 */
export const DASHBOARD_DEADLINE_STATUSES: readonly ProcessStatus[] = [
  'IN_PROGRESS',
  'AWAITING_APPROVAL',
  'RETURNED',
];

/** Ordem dos cartões de SCR-003 abaixo do resumo (os de resumo vêm de DSH-01). */
export const DASHBOARD_DEFAULT_LAYOUT: readonly DashboardWidgetKey[] = [
  'PENDING_ITEMS',
  'BY_STATUS',
  'BY_STAGE',
  'OVERDUE',
  'DUE_SOON',
  'AVG_STAGE_DURATION',
  'OPENED_BY_MONTH',
  'VALUE_BY_SECRETARIAT',
  'RECENT_ACTIVITY',
];

export const DASHBOARD_MESSAGES = Object.freeze({
  widgetNotFound: 'Indicador não encontrado.',
  invalidUnit: 'Selecione uma secretaria/unidade válida.',
  departmentNotInSecretariat: 'A unidade deve pertencer à secretaria selecionada.',
  limitOutOfRange: 'Informe um limite entre 1 e 100.',
  forbidden: 'Você não tem permissão para acessar o painel.',
  unavailable: 'Não foi possível carregar os indicadores agora.',
});

const uuidParam = z.uuid({ error: DASHBOARD_MESSAGES.invalidUnit });

/** DSH-01 — `?secretariatId=&departmentId=` (RN-DASH-09). */
export const dashboardFiltersSchema = z
  .strictObject({
    secretariatId: uuidParam.optional(),
    departmentId: uuidParam.optional(),
  })
  .meta({ id: 'DashboardFilters' });
export type DashboardFilters = z.infer<typeof dashboardFiltersSchema>;

const limitParam = z.coerce
  .number({ error: DASHBOARD_MESSAGES.limitOutOfRange })
  .int({ error: DASHBOARD_MESSAGES.limitOutOfRange })
  .min(DASHBOARD_RECENT_ACTIVITY_LIMITS.min, { error: DASHBOARD_MESSAGES.limitOutOfRange })
  .max(DASHBOARD_RECENT_ACTIVITY_LIMITS.max, { error: DASHBOARD_MESSAGES.limitOutOfRange });

/** DSH-02 — os filtros de DSH-01 e `limit` (só `RECENT_ACTIVITY`; ignorado nos demais — V-04). */
export const dashboardWidgetQuerySchema = dashboardFiltersSchema
  .extend({ limit: limitParam.optional() })
  .meta({ id: 'DashboardWidgetQuery' });
export type DashboardWidgetQuery = z.infer<typeof dashboardWidgetQuerySchema>;

/** `meta.cache` (RN-DASH-10): `hit` = servido do cache; `expiresAt` = fim da validade. */
export const dashboardCacheMetaSchema = z
  .object({ hit: z.boolean(), expiresAt: isoDateTimeSchema })
  .meta({ id: 'DashboardCacheMeta' });
export type DashboardCacheMeta = z.infer<typeof dashboardCacheMetaSchema>;

/** DSH-01. */
export const dashboardSummarySchema = z
  .object({
    /** Pendências de quem consulta: "Comigo" + "Aprovações pendentes" de TSK-02 (RN-DASH-03). */
    pendingCount: z.int().min(0),
    overdueCount: z.int().min(0),
    dueSoonCount: z.int().min(0),
    openCount: z.int().min(0),
    generatedAt: isoDateTimeSchema,
  })
  .meta({ id: 'DashboardSummary' });
export type DashboardSummaryDto = z.infer<typeof dashboardSummarySchema>;

export const dashboardSummaryResponseSchema = z.object({
  data: dashboardSummarySchema,
  meta: z.object({ cache: dashboardCacheMetaSchema }),
});
export type DashboardSummaryResponse = z.infer<typeof dashboardSummaryResponseSchema>;

/** Contagem de um grupo; `label` = nome resolvido (etapa, secretaria) ou `null` (enum/mês). */
const countItemSchema = <K extends z.ZodType<string>>(key: K) =>
  z.object({ key, label: z.string().nullable(), value: z.int().min(0) });

const widgetBase = { generatedAt: isoDateTimeSchema };

export const dashboardWidgetSchema = z
  .discriminatedUnion('widgetKey', [
    z.object({
      widgetKey: z.literal('PENDING_ITEMS'),
      /** = `pendingCount` de DSH-01. */
      total: z.int().min(0),
      /** Contadores de TSK-02 por visão; `UNIT_QUEUE` só quando a fila se aplica. */
      series: z.array(countItemSchema(z.enum(TASK_INBOX_VIEWS))),
      ...widgetBase,
    }),
    z.object({
      widgetKey: z.literal('BY_STATUS'),
      total: z.int().min(0),
      series: z.array(countItemSchema(z.enum(PROCESS_STATUSES))),
      ...widgetBase,
    }),
    z.object({
      widgetKey: z.literal('BY_STAGE'),
      total: z.int().min(0),
      /** `key` = `workflowStageId`. */
      series: z.array(countItemSchema(z.uuid())),
      ...widgetBase,
    }),
    z.object({
      widgetKey: z.literal('OVERDUE'),
      total: z.int().min(0),
      /** Por secretaria solicitante (`key` = id da unidade). */
      series: z.array(countItemSchema(z.uuid())),
      ...widgetBase,
    }),
    z.object({
      widgetKey: z.literal('DUE_SOON'),
      total: z.int().min(0),
      warnBeforeBusinessDays: z.int().min(0),
      series: z.array(countItemSchema(z.uuid())),
      ...widgetBase,
    }),
    z.object({
      widgetKey: z.literal('AVG_STAGE_DURATION'),
      windowDays: z.int().min(1),
      series: z.array(
        z.object({
          key: z.uuid(),
          label: z.string().nullable(),
          /** Média de `exitedAt − enteredAt`, em segundos. */
          value: z.int().min(0),
          sampleSize: z.int().min(1),
        }),
      ),
      ...widgetBase,
    }),
    z.object({
      widgetKey: z.literal('OPENED_BY_MONTH'),
      total: z.int().min(0),
      /** `key` = `YYYY-MM` no fuso do tenant, do mais antigo ao corrente (12 meses). */
      series: z.array(countItemSchema(z.string().regex(/^\d{4}-\d{2}$/))),
      ...widgetBase,
    }),
    z.object({
      widgetKey: z.literal('VALUE_BY_SECRETARIAT'),
      series: z.array(
        z.object({
          key: z.uuid(),
          label: z.string().nullable(),
          /** Soma de `estimatedValue` (decimal com 2 casas) dos processos somáveis (POL-09). */
          value: z.string().regex(/^\d+\.\d{2}$/),
          /** Há processo de orçamento sigiloso fora da soma (POL-09, agregados). */
          confidentialExcluded: z.boolean(),
        }),
      ),
      ...widgetBase,
    }),
    z.object({
      widgetKey: z.literal('RECENT_ACTIVITY'),
      items: z.array(
        timelineEntrySchema.extend({
          process: z.object({ id: z.uuid(), code: z.string().nullable() }),
        }),
      ),
      ...widgetBase,
    }),
  ])
  .meta({ id: 'DashboardWidget' });
export type DashboardWidgetDto = z.infer<typeof dashboardWidgetSchema>;
export type DashboardWidgetOf<K extends DashboardWidgetKey> = Extract<
  DashboardWidgetDto,
  { widgetKey: K }
>;

export const dashboardWidgetResponseSchema = z.object({
  data: dashboardWidgetSchema,
  meta: z.object({ generatedAt: isoDateTimeSchema, cache: dashboardCacheMetaSchema }),
});
export type DashboardWidgetResponse = z.infer<typeof dashboardWidgetResponseSchema>;
