import type { ChartTone, StatusTone } from '@contrataflow/ui';
import { DASHBOARD_DEADLINE_STATUSES, DASHBOARD_OPEN_STATUSES } from '@contrataflow/validation';
import type {
  DashboardFilters,
  DashboardWidgetDto,
  DashboardWidgetKey,
  DepartmentDto,
  ProcessDeadlineDto,
  ProcessStatus,
  TaskInboxView,
} from '@contrataflow/validation';
import { z } from 'zod';

import { isApiError } from '@/lib/api/api-error';

/*
 * Regras puras do painel (US-076 · SCR-003): filtros na URL (compartilháveis), atalhos para a lista
 * de processos e a caixa de tarefas com os mesmos predicados, formatação dos indicadores e a
 * paleta acessível (RN-DASH-12). Sem React — testadas isoladamente.
 */

const uuid = z.uuid();

/** Filtros válidos da URL (`?secretariatId=&departmentId=`); o inválido é descartado. */
export function parseDashboardFilters(params: URLSearchParams): DashboardFilters {
  const filters: { secretariatId?: string; departmentId?: string } = {};
  for (const key of ['secretariatId', 'departmentId'] as const) {
    const value = params.get(key);
    if (value !== null && uuid.safeParse(value).success) filters[key] = value;
  }
  return filters;
}

/** Filtros → query string (sem `?`), na ordem fixa. */
export function toDashboardSearch(filters: DashboardFilters): string {
  const params = new URLSearchParams();
  if (filters.secretariatId) params.set('secretariatId', filters.secretariatId);
  if (filters.departmentId) params.set('departmentId', filters.departmentId);
  return params.toString();
}

/** Conta como "Secretaria": `SECRETARIAT`/`BOARD` ou raiz do órgão (RN-TEN-49, já na DEP-01). */
const isSecretariat = (unit: DepartmentDto) => unit.isSecretariat;

/** Secretarias do filtro, por nome. */
export function secretariatOptions(units: readonly DepartmentDto[]): DepartmentDto[] {
  return units.filter(isSecretariat).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

/** Unidades do filtro: a subárvore da secretaria escolhida (sem ela), ou todas as não secretarias. */
export function departmentOptions(
  units: readonly DepartmentDto[],
  secretariatId: string | undefined,
): DepartmentDto[] {
  const secretariat = units.find((unit) => unit.id === secretariatId);
  return units.filter((unit) =>
    secretariat === undefined
      ? !isSecretariat(unit)
      : unit.id !== secretariat.id && unit.path.startsWith(secretariat.path),
  );
}

type ListParams = Readonly<Record<string, string | readonly string[]>>;

/**
 * Atalho para a lista de processos (SCR-004) com o recorte do painel: a secretaria solicitante e,
 * com unidade, o setor solicitante; os demais parâmetros vêm do cartão.
 */
export function processListHref(filters: DashboardFilters, extra: ListParams = {}): string {
  const params = new URLSearchParams();
  if (filters.secretariatId) params.set('requestingSecretariatId', filters.secretariatId);
  if (filters.departmentId) params.set('requestingDepartmentId', filters.departmentId);
  for (const [key, value] of Object.entries(extra)) {
    params.set(key, typeof value === 'string' ? value : value.join(','));
  }
  const search = params.toString();
  return search === '' ? '/processos' : `/processos?${search}`;
}

const OPEN = DASHBOARD_OPEN_STATUSES.join(',');
const DEADLINE = DASHBOARD_DEADLINE_STATUSES.join(',');

/** Atalhos do resumo (Fluxo principal, passo 6): mesmos predicados da caixa e da lista. */
export function summaryHrefs(filters: DashboardFilters) {
  return {
    pending: '/tarefas',
    overdue: processListHref(filters, { status: DEADLINE, overdue: 'true' }),
    dueSoon: processListHref(filters, { status: DEADLINE, sort: 'currentStageDueAt' }),
    open: processListHref(filters, { status: OPEN }),
  };
}

/** Atalho de um item da série (segmento do gráfico), quando houver. */
export function seriesItemHref(
  widgetKey: DashboardWidgetKey,
  key: string,
  filters: DashboardFilters,
): string | null {
  switch (widgetKey) {
    case 'PENDING_ITEMS':
      return '/tarefas';
    case 'BY_STATUS':
      return processListHref(filters, { status: key });
    case 'BY_STAGE':
      return processListHref(filters, { status: OPEN, currentWorkflowStageId: key });
    case 'OVERDUE':
      return processListHref(
        { ...filters, secretariatId: key },
        { status: DEADLINE, overdue: 'true' },
      );
    case 'DUE_SOON':
      return processListHref(
        { ...filters, secretariatId: key },
        { status: DEADLINE, sort: 'currentStageDueAt' },
      );
    case 'VALUE_BY_SECRETARIAT':
      return processListHref({ ...filters, secretariatId: key }, { status: OPEN });
    default:
      return null;
  }
}

/** Duração média (segundos) legível: dias com uma casa a partir de 1 dia, senão horas. */
export function formatDuration(seconds: number): {
  readonly unit: 'days' | 'hours';
  value: number;
} {
  const days = seconds / 86_400;
  if (days >= 1) return { unit: 'days', value: Math.round(days * 10) / 10 };
  return { unit: 'hours', value: Math.max(0, Math.round(seconds / 360) / 10) };
}

/** `YYYY-MM` → "out. de 2026" (sem depender do fuso do navegador). */
export function monthLabel(month: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${month}-15T12:00:00Z`));
}

/** O cartão não tem o que mostrar (estado vazio contextual — FA-01). */
export function isWidgetEmpty(widget: DashboardWidgetDto): boolean {
  switch (widget.widgetKey) {
    case 'RECENT_ACTIVITY':
      return widget.items.length === 0;
    case 'VALUE_BY_SECRETARIAT':
    case 'AVG_STAGE_DURATION':
      return widget.series.length === 0;
    default:
      return widget.total === 0;
  }
}

export type DashboardLoadProblem =
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'hidden' }
  | { readonly kind: 'rateLimited' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'invalidReference' }
  | { readonly kind: 'notInSecretariat' }
  | { readonly kind: 'unexpected'; readonly correlationId: string };

/** "Casos de erro" da story: o que cada cartão (e o filtro) faz com a falha. */
export function describeDashboardError(error: unknown): DashboardLoadProblem {
  if (!isApiError(error)) return { kind: 'unavailable' };
  if (error.status === 403) return { kind: 'forbidden' };
  // Indicador fora do registro: o cartão não é exibido.
  if (error.status === 404) return { kind: 'hidden' };
  if (error.status === 429) return { kind: 'rateLimited' };
  if (error.status === 422) {
    return error.errors.some((issue) => issue.code === 'DEPARTMENT_NOT_IN_SECRETARIAT')
      ? { kind: 'notInSecretariat' }
      : { kind: 'invalidReference' };
  }
  if (error.status >= 500 && error.status !== 503) {
    return { kind: 'unexpected', correlationId: error.correlationId ?? '—' };
  }
  return { kind: 'unavailable' };
}

/*
 * RN-DASH-12: as cores dos gráficos são os tons do design system v2 (`STATUS_CHART_TONE`,
 * `VIEW_CHIP_TONE`), com contraste validado em `packages/ui` (`tokens-contrast.test.ts`); a cor
 * nunca é a única informação — rótulo e valor em texto em todo gráfico, e a tabela alternativa.
 */

/** Período da saudação ("Bom dia/Boa tarde/Boa noite") pela hora no fuso do órgão. */
export function greetingPeriod(now: Date, timeZone: string): 'morning' | 'afternoon' | 'evening' {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(now),
  );
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  return 'evening';
}

/** Primeiro nome para a saudação ("Ana Souza" → "Ana"). */
export function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] ?? '';
}

/** Tom de cada situação no donut e na legenda (prd-4: semânticas com texto ao lado). */
export const STATUS_CHART_TONE: Readonly<Record<ProcessStatus, ChartTone>> = {
  DRAFT: 'neutral',
  IN_PROGRESS: 'info',
  AWAITING_APPROVAL: 'approval',
  RETURNED: 'warning',
  SUSPENDED: 'danger',
  CANCELED: 'navy',
  COMPLETED: 'success',
  PUBLISHED: 'success',
};

/** Tom do chip de cada visão da caixa de tarefas em "Minhas pendências". */
export const VIEW_CHIP_TONE: Readonly<Record<TaskInboxView, StatusTone>> = {
  MINE: 'info',
  UNIT_QUEUE: 'neutral',
  PENDING_APPROVALS: 'approval',
  RETURNED: 'warning',
  OVERDUE: 'danger',
  FOLLOWING: 'neutral',
};

/** Itens de "Minhas pendências" lidos da visão "Comigo" (TSK-01, uma página curta). */
export const PENDING_PREVIEW_SIZE = 5;

export type PendingDeadline =
  | { readonly kind: 'overdue'; readonly count: number; readonly calendar: boolean }
  | { readonly kind: 'dueToday' }
  | {
      readonly kind: 'dueIn';
      readonly count: number;
      readonly calendar: boolean;
      readonly soon: boolean;
    }
  | { readonly kind: 'paused' | 'overduePaused' | 'none' };

/**
 * Prazo de uma pendência como texto colorido: atrasado (vermelho), vence hoje ou em breve (âmbar)
 * e os demais com a contagem de dias (neutro) — a lista mostra "Vence em N dias" mesmo fora da
 * janela de alerta, diferente do selo "No prazo" da lista de processos.
 */
export function pendingDeadline(
  deadline: ProcessDeadlineDto,
  overdueSince: string | null,
): PendingDeadline {
  const calendar = deadline.slaType === 'CALENDAR';
  if (deadline.isPaused) return { kind: overdueSince === null ? 'paused' : 'overduePaused' };
  if (deadline.isOverdue) return { kind: 'overdue', count: deadline.overdueDays ?? 0, calendar };
  if (deadline.dueAt === null || deadline.daysLeft === null) return { kind: 'none' };
  if (deadline.daysLeft === 0) return { kind: 'dueToday' };
  return { kind: 'dueIn', count: deadline.daysLeft, calendar, soon: deadline.isDueSoon };
}

/** Tom do texto do prazo da pendência. */
export function pendingDeadlineTone(deadline: PendingDeadline): StatusTone {
  switch (deadline.kind) {
    case 'overdue':
    case 'overduePaused':
      return 'danger';
    case 'dueToday':
      return 'warning';
    case 'dueIn':
      return deadline.soon ? 'warning' : 'neutral';
    default:
      return 'neutral';
  }
}
