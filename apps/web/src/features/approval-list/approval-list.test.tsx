// @vitest-environment jsdom
import type { ApprovalListItemDto } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api/api-error';
import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, problem, renderWithShell, requestUrl } from '@test/support/render';

import {
  DEFAULT_FILTERS,
  activeRefinements,
  approvalListQuery,
  describeLoadError,
  effectiveSearch,
  hasActiveFilters,
  isPeriodValid,
  parseSortOption,
  sortOptions,
  statusTabOf,
  tabCountQuery,
} from './approval-list-model';
import { ApprovalListPage } from './approval-list-page';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

/*
 * US-057 — SCR-014 (`/aprovacoes`) no modelo de lista (prd-5): situação em abas com contadores,
 * busca inline, filtros no popover com chips, ordenação e paginação (APV-01), estados vazios (FA-01
 * × FA-05), erro com "Tentar novamente", navegação para o SCR-015 e acessibilidade (axe).
 */

const OBRAS = '0192e057-0000-7000-8000-0000000000a1';
const aid = (n: number) => `0192e057-0000-7000-8000-${String(n).padStart(12, '0')}`;

function item(n: number, overrides: Partial<ApprovalListItemDto> = {}): ApprovalListItemDto {
  return {
    id: aid(n),
    subjectType: 'PROCESS_STAGE',
    title: `Aprovação do DFD ${String(n)}`,
    status: 'PENDING',
    process: { id: aid(1000 + n), code: `${String(n).padStart(4, '0')}/2026`, title: 'Reforma' },
    document: null,
    requestingDepartment: { id: OBRAS, name: 'Secretaria de Obras' },
    requestedBy: { id: aid(900), name: 'Lúcia Ramos' },
    requestedAt: '2026-10-12T12:00:00.000Z',
    dueAt: '2026-10-24T02:59:59.000Z',
    isOverdue: false,
    approver: { type: 'DEPARTMENT_HEAD', label: 'Beatriz Lima (titular da Secretaria de Obras)' },
    isBudgetConfidential: false,
    ...overrides,
  };
}

const page = (items: ApprovalListItemDto[], totalPages = 1) =>
  jsonResponse({
    data: items,
    meta: { page: 1, pageSize: 20, totalItems: items.length, totalPages },
  });

function mockApi(list: (url: URL) => Response = () => page([item(1), item(2)])) {
  const fetchMock = vi.fn<typeof fetch>((input) => {
    const url = new URL(requestUrl(input), 'http://localhost');
    if (url.pathname === '/api/v1/approvals') return Promise.resolve(list(url));
    if (url.pathname === '/api/v1/departments/lookup') {
      return Promise.resolve(jsonResponse({ data: [{ id: OBRAS, name: 'Secretaria de Obras' }] }));
    }
    return Promise.resolve(problem(404, 'NOT_FOUND'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const allCalls = (fetchMock: ReturnType<typeof mockApi>) =>
  fetchMock.mock.calls
    .map(([input]) => new URL(requestUrl(input), 'http://localhost'))
    .filter((url) => url.pathname === '/api/v1/approvals');

/** Consultas da lista (os contadores das abas usam `pageSize=1`). */
const calls = (fetchMock: ReturnType<typeof mockApi>) =>
  allCalls(fetchMock).filter((url) => url.searchParams.get('pageSize') === '20');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SCR-014 — Aprovações (US-057)', () => {
  it('abre na aba Pendentes (PENDING, -requestedAt) com contadores; cada linha leva ao SCR-015 e ao processo', async () => {
    const fetchMock = mockApi((url) =>
      url.searchParams.get('pageSize') === '1'
        ? jsonResponse({
            data: [],
            meta: { page: 1, pageSize: 1, totalItems: 4, totalPages: 4 },
          })
        : page([item(1, { isOverdue: true, isBudgetConfidential: true }), item(2)]),
    );
    renderWithShell(<ApprovalListPage />);
    const link = await screen.findByRole('link', {
      name: 'Abrir Aprovação do DFD 1 do processo 0001/2026',
    });
    expect(link.getAttribute('href')).toBe(`/aprovacoes/${aid(1)}`);
    expect(screen.getByRole('link', { name: '0001/2026' }).getAttribute('href')).toBe(
      `/processos/${aid(1001)}`,
    );
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(screen.getByText(/^Em atraso/)).toBeTruthy();
    expect(screen.getAllByText(/Beatriz Lima \(titular da Secretaria de Obras\)/)).toHaveLength(2);
    const pending = await screen.findByRole('tab', { name: 'Pendentes: 2 aprovações' });
    expect(pending.getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByRole('tab', { name: 'Aprovadas: 4 aprovações' })).toBeTruthy();
    const [first] = calls(fetchMock);
    expect(first?.searchParams.get('status')).toBe('PENDING');
    expect(first?.searchParams.get('sort')).toBe('-requestedAt');
    expect(first?.searchParams.get('page')).toBe('1');
    expect(first?.searchParams.get('pageSize')).toBe('20');
    // Contador de cada aba: APV-01 com a situação da aba e `pageSize=1`.
    expect(
      allCalls(fetchMock)
        .filter((url) => url.searchParams.get('pageSize') === '1')
        .map((url) => url.searchParams.get('status'))
        .sort(),
    ).toEqual(['APPROVED', 'CANCELED', 'REJECTED', 'RETURNED']);
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('FA-01: sem pendências, "Você está em dia" leva às aprovações concluídas', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi(() => page([]));
    renderWithShell(<ApprovalListPage />);
    expect(await screen.findByText('Nenhuma aprovação pendente')).toBeTruthy();
    expect(screen.getByText(/Você está em dia\./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Limpar filtros' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Ver aprovações concluídas' }));
    await waitFor(() => {
      expect(calls(fetchMock).at(-1)?.searchParams.get('status')).toBe('APPROVED');
    });
    expect(screen.getByRole('tab', { name: /Aprovadas/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('abas, busca e filtros do popover reconsultam a API; FA-05 sem resultado oferece "Limpar filtros"', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi((url) =>
      url.searchParams.get('subjectType') === 'DOCUMENT' ? page([]) : page([item(1)]),
    );
    renderWithShell(<ApprovalListPage />);
    await screen.findByRole('link', { name: /Abrir Aprovação do DFD 1/ });
    await user.click(screen.getByRole('tab', { name: /Aprovadas/ }));
    await waitFor(() => {
      expect(calls(fetchMock).at(-1)?.searchParams.get('status')).toBe('APPROVED');
    });
    // Filtros fechados por padrão (prd-5 · regra 2).
    expect(screen.queryByRole('combobox', { name: 'Tipo de assunto' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Filtros' }));
    await user.click(await screen.findByRole('combobox', { name: 'Unidade solicitante' }));
    await user.click(await screen.findByRole('option', { name: 'Secretaria de Obras' }));
    await waitFor(() => {
      expect(calls(fetchMock).at(-1)?.searchParams.get('requestingDepartmentId')).toBe(OBRAS);
    });
    expect(await screen.findByText('Unidade solicitante: Secretaria de Obras')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Filtros, 1 filtro ativo' })).toBeTruthy();
    await user.keyboard('{Escape}');

    await user.type(screen.getByRole('searchbox', { name: 'Buscar aprovações' }), 'reforma');
    await waitFor(() => {
      expect(calls(fetchMock).at(-1)?.searchParams.get('q')).toBe('reforma');
    });
    await user.click(screen.getByRole('combobox', { name: 'Ordenar por' }));
    await user.click(await screen.findByRole('option', { name: 'Prazo (mais próximo primeiro)' }));
    await waitFor(() => {
      expect(calls(fetchMock).at(-1)?.searchParams.get('sort')).toBe('dueAt');
    });

    await user.click(screen.getByRole('button', { name: /^Filtros/ }));
    await user.click(await screen.findByRole('combobox', { name: 'Tipo de assunto' }));
    await user.click(await screen.findByRole('option', { name: 'Documento avulso' }));
    await user.keyboard('{Escape}');
    expect(
      await screen.findByText('Nenhuma aprovação encontrada para os filtros selecionados.'),
    ).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);
    await user.click(
      within(screen.getByRole('tabpanel')).getByRole('button', { name: 'Limpar filtros' }),
    );
    await waitFor(() => {
      const last = calls(fetchMock).at(-1);
      // A aba (situação) continua; os demais filtros e a busca saem.
      expect(last?.searchParams.get('status')).toBe('APPROVED');
      expect(last?.searchParams.has('subjectType')).toBe(false);
      expect(last?.searchParams.has('requestingDepartmentId')).toBe(false);
      expect(last?.searchParams.has('q')).toBe(false);
    });
    expect(
      screen.getByRole<HTMLInputElement>('searchbox', { name: 'Buscar aprovações' }).value,
    ).toBe('');
  });

  it('período da solicitação no DateRangePicker vira requestedFrom/requestedTo e um chip', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi();
    renderWithShell(<ApprovalListPage />);
    await screen.findByRole('link', { name: /Abrir Aprovação do DFD 1/ });
    await user.click(screen.getByRole('button', { name: 'Filtros' }));
    await user.click(await screen.findByRole('button', { name: /Período da solicitação/ }));
    const calendar = await screen.findByRole('dialog', { name: 'Escolher período' });
    const [fifth] = within(calendar).getAllByRole('button', { name: /, 5 de / });
    const [ninth] = within(calendar).getAllByRole('button', { name: /, 9 de / });
    if (!fifth || !ninth) throw new Error('dias do calendário não encontrados');
    await user.click(fifth);
    await user.click(ninth);
    await waitFor(() => {
      const last = calls(fetchMock).at(-1);
      expect(last?.searchParams.get('requestedFrom')).toMatch(/^\d{4}-\d{2}-05$/);
      expect(last?.searchParams.get('requestedTo')).toMatch(/^\d{4}-\d{2}-09$/);
    });
    expect(await screen.findByText(/^Período da solicitação: 05\//)).toBeTruthy();
  });

  it('banco indisponível: mensagem e "Tentar novamente" reconsulta', async () => {
    const user = userEvent.setup();
    let fail = true;
    const fetchMock = mockApi(() =>
      fail ? problem(503, 'DEPENDENCY_UNAVAILABLE') : page([item(1)]),
    );
    renderWithShell(<ApprovalListPage />);
    expect(await screen.findByText('Não foi possível carregar as aprovações agora.')).toBeTruthy();
    fail = false;
    const before = calls(fetchMock).length;
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await screen.findByRole('link', { name: /Abrir Aprovação do DFD 1/ });
    expect(calls(fetchMock).length).toBe(before + 1);
  });

  it('pagina quando há mais de uma página', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi(() => page([item(1)], 2));
    renderWithShell(<ApprovalListPage />);
    await screen.findByText('Página 1 de 2');
    await user.click(screen.getByRole('button', { name: 'Próxima' }));
    await waitFor(() => {
      expect(calls(fetchMock).at(-1)?.searchParams.get('page')).toBe('2');
    });
  });
});

describe('approval-list-model', () => {
  it('aba = um status; contador com os demais filtros e pageSize=1; refinamentos além da aba', () => {
    expect(statusTabOf(DEFAULT_FILTERS)).toBe('PENDING');
    expect(statusTabOf({ ...DEFAULT_FILTERS, statuses: ['REJECTED'] })).toBe('REJECTED');
    expect(
      tabCountQuery({ ...DEFAULT_FILTERS, subjectType: 'DOCUMENT', q: 'obras' }, 'APPROVED'),
    ).toMatchObject({ status: 'APPROVED', subjectType: 'DOCUMENT', q: 'obras', pageSize: 1 });
    expect(activeRefinements({ ...DEFAULT_FILTERS, statuses: ['APPROVED'] })).toEqual([]);
    expect(activeRefinements({ ...DEFAULT_FILTERS, requestedTo: '2026-10-01', q: 'a' })).toEqual([
      'period',
    ]);
  });

  it('query: vazios fora, busca curta ignorada (V-03), status por vírgula', () => {
    expect(
      approvalListQuery({ ...DEFAULT_FILTERS, q: ' a ' }, { field: 'code', direction: 'asc' }, 2),
    ).toEqual({
      status: 'PENDING',
      subjectType: undefined,
      requestingDepartmentId: undefined,
      requestedFrom: undefined,
      requestedTo: undefined,
      q: undefined,
      sort: 'code',
      page: 2,
      pageSize: 20,
    });
    expect(effectiveSearch('  obras ')).toBe('obras');
  });

  it('período, filtros ativos e ordenação', () => {
    expect(
      isPeriodValid({ ...DEFAULT_FILTERS, requestedFrom: '2026-10-02', requestedTo: '2026-10-01' }),
    ).toBe(false);
    expect(isPeriodValid({ ...DEFAULT_FILTERS, requestedFrom: '2026-10-02' })).toBe(true);
    expect(hasActiveFilters(DEFAULT_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...DEFAULT_FILTERS, q: 'a' })).toBe(false);
    expect(hasActiveFilters({ ...DEFAULT_FILTERS, statuses: ['APPROVED'] })).toBe(true);
    expect(sortOptions()).toEqual([
      '-requestedAt',
      'requestedAt',
      '-dueAt',
      'dueAt',
      'code',
      '-code',
    ]);
    expect(parseSortOption('title')).toEqual({ field: 'requestedAt', direction: 'desc' });
  });

  it('falhas (tabela "Casos de erro")', () => {
    const department = new ApiError({
      status: 422,
      code: 'VALIDATION_ERROR',
      errors: [{ field: 'requestingDepartmentId', code: 'REFERENCE_NOT_FOUND', message: 'x' }],
    });
    expect(describeLoadError(department)).toEqual({ kind: 'invalidDepartment' });
    expect(describeLoadError(new ApiError({ status: 422, code: 'VALIDATION_ERROR' }))).toEqual({
      kind: 'invalidFilter',
    });
    expect(describeLoadError(new ApiError({ status: 429, code: 'RATE_LIMITED' }))).toEqual({
      kind: 'rateLimited',
    });
    expect(
      describeLoadError(new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c1' })),
    ).toEqual({ kind: 'unexpected', correlationId: 'c1' });
    expect(describeLoadError(new Error('rede'))).toEqual({ kind: 'unavailable' });
  });
});
