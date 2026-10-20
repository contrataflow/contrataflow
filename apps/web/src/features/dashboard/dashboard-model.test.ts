import { MIN_TEXT_CONTRAST } from '@contrataflow/ui';
import type { DepartmentDto } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/api-error';

import {
  barPercent,
  departmentOptions,
  describeDashboardError,
  formatDuration,
  isWidgetEmpty,
  monthLabel,
  paletteMinContrast,
  parseDashboardFilters,
  processListHref,
  secretariatOptions,
  seriesItemHref,
  summaryHrefs,
  toDashboardSearch,
} from './dashboard-model';

/* US-076 — regras puras de SCR-003 (filtros na URL, atalhos, formatação e paleta — RN-DASH-12). */

const ID = (n: number) => `0192e076-0000-7000-8000-${String(n).padStart(12, '0')}`;
const OBRAS = ID(1);
const MANUT = ID(2);
const SAUDE = ID(3);

function unit(id: string, name: string, patch: Partial<DepartmentDto> = {}): DepartmentDto {
  return {
    id,
    organizationId: ID(99),
    parentId: null,
    type: 'SECRETARIAT',
    name,
    acronym: null,
    code: null,
    email: null,
    phone: null,
    headUserId: null,
    deputyUserId: null,
    isActive: true,
    isSecretariat: true,
    sortOrder: 0,
    path: `/${id}/`,
    depth: 0,
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z',
    version: 1,
    ...patch,
  };
}

const UNITS = [
  unit(SAUDE, 'Secretaria de Saúde'),
  unit(OBRAS, 'Secretaria de Obras'),
  unit(MANUT, 'Setor de Manutenção', {
    parentId: OBRAS,
    type: 'SECTOR',
    isSecretariat: false,
    path: `/${OBRAS}/${MANUT}/`,
    depth: 1,
  }),
];

describe('filtros na URL', () => {
  it('lê só ids válidos e escreve na ordem fixa', () => {
    const filters = parseDashboardFilters(
      new URLSearchParams(`departmentId=${MANUT}&secretariatId=${OBRAS}&x=1`),
    );
    expect(filters).toEqual({ secretariatId: OBRAS, departmentId: MANUT });
    expect(toDashboardSearch(filters)).toBe(`secretariatId=${OBRAS}&departmentId=${MANUT}`);
    expect(parseDashboardFilters(new URLSearchParams('secretariatId=abc'))).toEqual({});
    expect(toDashboardSearch({})).toBe('');
  });

  it('secretarias por nome; unidades da subárvore da secretaria escolhida', () => {
    expect(secretariatOptions(UNITS).map((u) => u.name)).toEqual([
      'Secretaria de Obras',
      'Secretaria de Saúde',
    ]);
    expect(departmentOptions(UNITS, OBRAS).map((u) => u.id)).toEqual([MANUT]);
    expect(departmentOptions(UNITS, SAUDE)).toEqual([]);
    expect(departmentOptions(UNITS, undefined).map((u) => u.id)).toEqual([MANUT]);
  });
});

describe('atalhos (Fluxo principal, passo 6)', () => {
  it('lista de processos com o recorte e os mesmos predicados do cartão', () => {
    expect(processListHref({})).toBe('/processos');
    expect(
      processListHref({ secretariatId: OBRAS, departmentId: MANUT }, { overdue: 'true' }),
    ).toBe(
      `/processos?requestingSecretariatId=${OBRAS}&requestingDepartmentId=${MANUT}&overdue=true`,
    );
    const hrefs = summaryHrefs({});
    expect(hrefs.pending).toBe('/tarefas');
    expect(hrefs.overdue).toContain('overdue=true');
    expect(decodeURIComponent(hrefs.open)).toContain(
      'status=IN_PROGRESS,AWAITING_APPROVAL,RETURNED,SUSPENDED',
    );
  });

  it('segmentos: status, etapa, secretaria; sem atalho para meses e tempo médio', () => {
    expect(seriesItemHref('BY_STATUS', 'DRAFT', {})).toBe('/processos?status=DRAFT');
    expect(seriesItemHref('BY_STAGE', ID(9), {})).toContain(`currentWorkflowStageId=${ID(9)}`);
    expect(seriesItemHref('OVERDUE', SAUDE, { secretariatId: OBRAS })).toContain(
      `requestingSecretariatId=${SAUDE}`,
    );
    expect(seriesItemHref('DUE_SOON', SAUDE, {})).toContain('sort=currentStageDueAt');
    expect(seriesItemHref('VALUE_BY_SECRETARIAT', SAUDE, {})).toContain(SAUDE);
    expect(seriesItemHref('PENDING_ITEMS', 'MINE', {})).toBe('/tarefas');
    expect(seriesItemHref('OPENED_BY_MONTH', '2026-10', {})).toBeNull();
    expect(seriesItemHref('AVG_STAGE_DURATION', ID(9), {})).toBeNull();
  });
});

describe('formatação', () => {
  it('duração em dias (1 casa) ou horas; mês por extenso curto; barras', () => {
    expect(formatDuration(3 * 86_400)).toEqual({ unit: 'days', value: 3 });
    expect(formatDuration(1.25 * 86_400)).toEqual({ unit: 'days', value: 1.3 });
    expect(formatDuration(5400)).toEqual({ unit: 'hours', value: 1.5 });
    expect(monthLabel('2026-10')).toMatch(/out/);
    expect(barPercent(5, 10)).toBe(50);
    expect(barPercent(1, 1000)).toBe(2);
    expect(barPercent(0, 10)).toBe(0);
    expect(barPercent(3, 0)).toBe(0);
  });

  it('estado vazio por indicador (FA-01)', () => {
    const at = '2026-10-20T15:00:00.000Z';
    expect(isWidgetEmpty({ widgetKey: 'RECENT_ACTIVITY', items: [], generatedAt: at })).toBe(true);
    expect(isWidgetEmpty({ widgetKey: 'VALUE_BY_SECRETARIAT', series: [], generatedAt: at })).toBe(
      true,
    );
    expect(isWidgetEmpty({ widgetKey: 'BY_STATUS', total: 0, series: [], generatedAt: at })).toBe(
      true,
    );
    expect(
      isWidgetEmpty({
        widgetKey: 'OVERDUE',
        total: 1,
        series: [{ key: OBRAS, label: 'Obras', value: 1 }],
        generatedAt: at,
      }),
    ).toBe(false);
  });
});

describe('Casos de erro', () => {
  const error = (status: number, code: string, fieldCode?: string) =>
    new ApiError({
      status,
      code,
      correlationId: 'c-1',
      errors:
        fieldCode === undefined
          ? []
          : [{ field: 'departmentId', code: fieldCode as 'REFERENCE_NOT_FOUND', message: 'x' }],
    });

  it('mapeia cada situação para o comportamento do cartão', () => {
    expect(describeDashboardError(error(403, 'PERMISSION_DENIED'))).toEqual({ kind: 'forbidden' });
    expect(describeDashboardError(error(404, 'WIDGET_NOT_FOUND'))).toEqual({ kind: 'hidden' });
    expect(describeDashboardError(error(429, 'RATE_LIMITED'))).toEqual({ kind: 'rateLimited' });
    expect(describeDashboardError(error(422, 'VALIDATION_ERROR', 'REFERENCE_NOT_FOUND'))).toEqual({
      kind: 'invalidReference',
    });
    expect(
      describeDashboardError(error(422, 'VALIDATION_ERROR', 'DEPARTMENT_NOT_IN_SECRETARIAT')),
    ).toEqual({ kind: 'notInSecretariat' });
    expect(describeDashboardError(error(503, 'DEPENDENCY_UNAVAILABLE'))).toEqual({
      kind: 'unavailable',
    });
    expect(describeDashboardError(error(500, 'INTERNAL_ERROR'))).toEqual({
      kind: 'unexpected',
      correlationId: 'c-1',
    });
    expect(describeDashboardError(new Error('rede'))).toEqual({ kind: 'unavailable' });
  });
});

describe('RN-DASH-12 — paleta', () => {
  it('toda cor de barra tem contraste ≥ 3:1 com o cartão (objeto gráfico) e ≥ AA de texto', () => {
    expect(paletteMinContrast()).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });
});
