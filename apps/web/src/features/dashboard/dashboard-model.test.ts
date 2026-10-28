import type { DepartmentDto, ProcessDeadlineDto } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/api-error';

import {
  departmentOptions,
  describeDashboardError,
  firstName,
  formatDuration,
  greetingPeriod,
  isWidgetEmpty,
  monthLabel,
  parseDashboardFilters,
  pendingDeadline,
  pendingDeadlineTone,
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

describe('saudação do cabeçalho', () => {
  it('período pela hora no fuso do órgão e o primeiro nome', () => {
    // 11:30 UTC = 08:30 em São Paulo, 07:30 em Manaus.
    const morning = new Date('2026-10-28T11:30:00Z');
    expect(greetingPeriod(morning, 'America/Sao_Paulo')).toBe('morning');
    expect(greetingPeriod(new Date('2026-10-28T15:00:00Z'), 'America/Sao_Paulo')).toBe('afternoon');
    expect(greetingPeriod(new Date('2026-10-28T21:00:00Z'), 'America/Sao_Paulo')).toBe('evening');
    // 03:00 em São Paulo ainda é "Boa noite".
    expect(greetingPeriod(new Date('2026-10-28T06:00:00Z'), 'America/Sao_Paulo')).toBe('evening');
    expect(firstName('  Ana   Souza ')).toBe('Ana');
  });
});

describe('prazo de "Minhas pendências"', () => {
  const base: ProcessDeadlineDto = {
    dueAt: '2026-10-30T02:59:59.000Z',
    slaType: 'BUSINESS',
    daysLeft: 6,
    overdueDays: null,
    isDueSoon: false,
    isOverdue: false,
    isPaused: false,
  };

  it('atrasado em vermelho, hoje/em breve em âmbar e os demais neutros com a contagem', () => {
    const overdue = pendingDeadline(
      { ...base, daysLeft: null, overdueDays: 3, isOverdue: true },
      '2026-10-25T00:00:00Z',
    );
    expect(overdue).toEqual({ kind: 'overdue', count: 3, calendar: false });
    expect(pendingDeadlineTone(overdue)).toBe('danger');
    const today = pendingDeadline({ ...base, daysLeft: 0, isDueSoon: true }, null);
    expect(today).toEqual({ kind: 'dueToday' });
    expect(pendingDeadlineTone(today)).toBe('warning');
    const soon = pendingDeadline({ ...base, daysLeft: 2, isDueSoon: true }, null);
    expect(pendingDeadlineTone(soon)).toBe('warning');
    const later = pendingDeadline({ ...base, slaType: 'CALENDAR' }, null);
    expect(later).toEqual({ kind: 'dueIn', count: 6, calendar: true, soon: false });
    expect(pendingDeadlineTone(later)).toBe('neutral');
  });

  it('pausado, atrasado e suspenso, e sem prazo', () => {
    expect(pendingDeadline({ ...base, isPaused: true }, null)).toEqual({ kind: 'paused' });
    const pausedLate = pendingDeadline({ ...base, isPaused: true }, '2026-10-20T00:00:00Z');
    expect(pausedLate).toEqual({ kind: 'overduePaused' });
    expect(pendingDeadlineTone(pausedLate)).toBe('danger');
    const none = pendingDeadline({ ...base, dueAt: null, daysLeft: null }, null);
    expect(none).toEqual({ kind: 'none' });
    expect(pendingDeadlineTone(none)).toBe('neutral');
  });
});
