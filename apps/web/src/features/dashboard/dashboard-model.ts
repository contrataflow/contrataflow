import { contrastRatio } from '@contrataflow/ui';
import { DASHBOARD_DEADLINE_STATUSES, DASHBOARD_OPEN_STATUSES } from '@contrataflow/validation';
import type {
  DashboardFilters,
  DashboardWidgetDto,
  DashboardWidgetKey,
  DepartmentDto,
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

/** Largura relativa da barra (0–100), com um mínimo visível para valores > 0. */
export function barPercent(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0;
  return Math.max(2, Math.round((value / max) * 100));
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

/**
 * RN-DASH-12: cores das barras sobre o cartão (`--color-surface`, tema claro), com contraste de
 * objeto gráfico ≥ 3:1 (WCAG 1.4.11). A cor nunca é a única informação: cada barra tem rótulo,
 * valor em texto e, nos alertas, padrão listrado e ícone.
 */
export const DASHBOARD_PALETTE = Object.freeze({
  surface: '#ffffff',
  neutral: '#005bf9',
  danger: '#b91c1c',
  warning: '#92400e',
  success: '#15803d',
});

export type DashboardTone = Exclude<keyof typeof DASHBOARD_PALETTE, 'surface'>;

/** Menor contraste da paleta contra o fundo do cartão. */
export function paletteMinContrast(): number {
  const { surface, ...tones } = DASHBOARD_PALETTE;
  return Math.min(...Object.values(tones).map((color) => contrastRatio(color, surface) ?? 0));
}
