import { describe, expect, it } from 'vitest';

import {
  PROCESS_EXPORT_MAX_ROWS,
  PROCESS_EXPORT_MESSAGES,
  processExportHeaders,
  processExportQuerySchema,
} from './process-export.js';
import {
  SAVED_VIEW_FILTER_KEYS,
  SAVED_VIEW_MESSAGES,
  createSavedViewSchema,
  paramsFromSavedViewFilters,
  processColumnsSchema,
  savedViewFiltersFromParams,
  savedViewFiltersSchema,
  savedViewSortSchema,
  updateSavedViewSchema,
  upcastSavedViewFilters,
} from './saved-views.js';

const UNIT = '01920000-0000-7000-8000-000000000001';

const view = (overrides: Record<string, unknown> = {}) => ({
  scope: 'PROCESS_LIST',
  name: 'Atrasados por prioridade',
  filters: { v: 1, overdue: true },
  sort: '-priority',
  columns: ['code', 'title', 'status'],
  ...overrides,
});

describe('savedViewFiltersSchema (US-003 · RN-PROC-35 · V-03)', () => {
  it('aceita o exemplo da story (listas, booleano e valores reservados)', () => {
    const filters = {
      v: 1,
      status: ['IN_PROGRESS', 'RETURNED'],
      overdue: true,
      requestingSecretariatId: [UNIT],
      currentResponsibleId: ['none'],
    };
    expect(savedViewFiltersSchema.parse(filters)).toEqual(filters);
  });

  it.each([
    ['sem versão', { status: ['DRAFT'] }],
    ['versão desconhecida', { v: 2 }],
    ['filtro desconhecido', { v: 1, foo: 'x' }],
    ['enum inválido', { v: 1, status: ['ABERTO'] }],
    ['paginação', { v: 1, page: 2 }],
    ['lista vazia', { v: 1, priority: [] }],
    ['intervalo invertido', { v: 1, createdFrom: '2026-02-01', createdTo: '2026-01-01' }],
  ])('recusa %s', (_case, filters) => {
    const result = savedViewFiltersSchema.safeParse(filters);
    expect(result.success).toBe(false);
  });

  it('a mensagem de filtro inválido é a de V-03', () => {
    const result = savedViewFiltersSchema.safeParse({ v: 1, status: ['ABERTO'] });
    expect(result.error?.issues[0]?.message).toBe(SAVED_VIEW_MESSAGES.invalidFilters);
  });

  it('upcaster: v1 passa, JSON irreconhecível vira null', () => {
    expect(upcastSavedViewFilters({ v: 1, year: [2026] })).toEqual({ v: 1, year: [2026] });
    expect(upcastSavedViewFilters({ v: 9 })).toBeNull();
    expect(upcastSavedViewFilters('x')).toBeNull();
  });
});

describe('conversão URL ⇄ filters', () => {
  it('ida e volta preserva os filtros e descarta paginação e ordenação', () => {
    const params = {
      status: 'IN_PROGRESS,RETURNED',
      overdue: 'true',
      year: '2025,2026',
      currentDepartmentId: 'mine',
      estimatedValueMin: '100.50',
      page: '3',
      pageSize: '50',
      sort: '-priority',
    };
    const filters = savedViewFiltersFromParams(params);
    expect(filters).toEqual({
      v: 1,
      status: ['IN_PROGRESS', 'RETURNED'],
      currentDepartmentId: ['mine'],
      year: [2025, 2026],
      overdue: true,
      estimatedValueMin: '100.50',
    });
    expect(savedViewFiltersSchema.safeParse(filters).success).toBe(true);
    expect(paramsFromSavedViewFilters(filters)).toEqual({
      status: 'IN_PROGRESS,RETURNED',
      currentDepartmentId: 'mine',
      year: '2025,2026',
      overdue: 'true',
      estimatedValueMin: '100.50',
    });
  });

  it('ignora parâmetros vazios ou inválidos', () => {
    expect(savedViewFiltersFromParams({ status: '', priority: 'X' })).toEqual({ v: 1 });
    expect(SAVED_VIEW_FILTER_KEYS).not.toContain('page');
  });
});

describe('createSavedViewSchema / updateSavedViewSchema (PRC-36/37)', () => {
  it('aplica os padrões de isShared/isDefault e apara o nome', () => {
    expect(createSavedViewSchema.parse(view({ name: '  Minha fila  ' }))).toMatchObject({
      name: 'Minha fila',
      isShared: false,
      isDefault: false,
    });
  });

  it('V-01: nome vazio ou com 81 caracteres', () => {
    for (const name of ['   ', 'x'.repeat(81)]) {
      const result = createSavedViewSchema.safeParse(view({ name }));
      expect(result.error?.issues[0]).toMatchObject({
        path: ['name'],
        message: SAVED_VIEW_MESSAGES.name,
      });
    }
    expect(createSavedViewSchema.safeParse(view({ name: 'x'.repeat(80) })).success).toBe(true);
  });

  it('V-04: colunas sem code/title, repetidas ou desconhecidas', () => {
    for (const columns of [
      ['code', 'status'],
      ['code', 'title', 'title'],
      ['code', 'title', 'x'],
    ]) {
      expect(processColumnsSchema.safeParse(columns).success).toBe(false);
    }
  });

  it('ordenação na sintaxe de RN-PROC-27, até 120 caracteres', () => {
    expect(savedViewSortSchema.safeParse('-priority,code').success).toBe(true);
    expect(savedViewSortSchema.safeParse('-foo').success).toBe(false);
    expect(createSavedViewSchema.safeParse(view({ sort: null })).success).toBe(true);
  });

  it('PATCH é estrito e não muda o escopo', () => {
    expect(updateSavedViewSchema.safeParse({ scope: 'INBOX' }).success).toBe(false);
    expect(updateSavedViewSchema.parse({ isDefault: true })).toEqual({ isDefault: true });
  });
});

describe('processExportQuerySchema (PRC-34)', () => {
  it('mesmos filtros de PRC-01 + columns, sem paginação', () => {
    const query = processExportQuerySchema.parse({
      status: 'IN_PROGRESS,RETURNED',
      sort: '-priority',
      columns: 'code,title,status,estimatedValue,status',
      page: '2',
    });
    expect(query).toMatchObject({
      status: ['IN_PROGRESS', 'RETURNED'],
      sort: [{ field: 'priority', direction: 'desc' }],
      columns: ['code', 'title', 'status', 'estimatedValue'],
    });
    expect(query).not.toHaveProperty('page');
  });

  it('V-08: filtro ou coluna inválidos', () => {
    expect(processExportQuerySchema.safeParse({ status: 'X' }).success).toBe(false);
    expect(processExportQuerySchema.safeParse({ columns: 'foo' }).success).toBe(false);
  });

  it('cabeçalhos e mensagens', () => {
    expect(processExportHeaders('estimatedValue', { secretariat: 'S', department: 'D' })).toEqual([
      'Valor estimado',
      'Orçamento sigiloso',
    ]);
    expect(
      processExportHeaders('requestingSecretariat', { secretariat: 'Diretoria', department: 'D' }),
    ).toEqual(['Diretoria solicitante']);
    expect(PROCESS_EXPORT_MAX_ROWS).toBe(10_000);
    expect(PROCESS_EXPORT_MESSAGES.tooLarge(10_240)).toBe(
      'A consulta tem 10.240 processos. Refine os filtros para exportar até 10.000.',
    );
  });
});
