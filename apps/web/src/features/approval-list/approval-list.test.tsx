// @vitest-environment jsdom
import type { ApprovalListItemDto } from '@contrataflow/validation';
import { configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api/api-error';
import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, problem, renderWithShell, requestUrl } from '@test/support/render';

import {
  DEFAULT_FILTERS,
  approvalListQuery,
  describeLoadError,
  effectiveSearch,
  hasActiveFilters,
  isPeriodValid,
  parseSortOption,
  sortOptions,
} from './approval-list-model';
import { ApprovalListPage } from './approval-list-page';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

/*
 * US-057 — SCR-014 (`/aprovacoes`): lista da cobertura (APV-01) com filtros, ordenação e paginação,
 * V-02 sem chamada à API, estados vazios (FA-01 × FA-05), erro com "Tentar novamente",
 * navegação para o SCR-015 e acessibilidade (axe).
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

const calls = (fetchMock: ReturnType<typeof mockApi>) =>
  fetchMock.mock.calls
    .map(([input]) => new URL(requestUrl(input), 'http://localhost'))
    .filter((url) => url.pathname === '/api/v1/approvals');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SCR-014 — Aprovações (US-057)', () => {
  it('abre com o filtro padrão PENDING e -requestedAt; cada linha leva ao SCR-015 e ao processo', async () => {
    const fetchMock = mockApi(() =>
      page([item(1, { isOverdue: true, isBudgetConfidential: true }), item(2)]),
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
    expect(screen.getByText('Em atraso')).toBeTruthy();
    expect(screen.getAllByText(/Beatriz Lima \(titular da Secretaria de Obras\)/)).toHaveLength(2);
    const [first] = calls(fetchMock);
    expect(first?.searchParams.get('status')).toBe('PENDING');
    expect(first?.searchParams.get('sort')).toBe('-requestedAt');
    expect(first?.searchParams.get('page')).toBe('1');
    expect(first?.searchParams.get('pageSize')).toBe('20');
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('FA-01: sem pendências mostra "Nenhuma aprovação pendente. Você está em dia!"', async () => {
    mockApi(() => page([]));
    renderWithShell(<ApprovalListPage />);
    expect(await screen.findByText('Nenhuma aprovação pendente. Você está em dia!')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Limpar filtros' })).toBeNull();
  });

  it('filtros reconsultam a API; FA-05 sem resultado oferece "Limpar filtros"', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi((url) =>
      url.searchParams.get('subjectType') === 'DOCUMENT' ? page([]) : page([item(1)]),
    );
    renderWithShell(<ApprovalListPage />);
    await screen.findByRole('link', { name: /Abrir Aprovação do DFD 1/ });
    await user.click(screen.getByRole('checkbox', { name: 'Aprovada' }));
    await waitFor(() => {
      expect(calls(fetchMock).at(-1)?.searchParams.get('status')).toBe('PENDING,APPROVED');
    });
    await user.selectOptions(await screen.findByLabelText('Unidade solicitante'), OBRAS);
    await waitFor(() => {
      expect(calls(fetchMock).at(-1)?.searchParams.get('requestingDepartmentId')).toBe(OBRAS);
    });
    await user.type(screen.getByLabelText('Buscar por código ou título'), 'reforma');
    await user.click(screen.getByRole('button', { name: 'Buscar' }));
    await waitFor(() => {
      expect(calls(fetchMock).at(-1)?.searchParams.get('q')).toBe('reforma');
    });
    await user.selectOptions(screen.getByLabelText('Ordenar por'), 'dueAt');
    await waitFor(() => {
      expect(calls(fetchMock).at(-1)?.searchParams.get('sort')).toBe('dueAt');
    });
    await user.selectOptions(screen.getByLabelText('Tipo de assunto'), 'DOCUMENT');
    expect(
      await screen.findByText('Nenhuma aprovação encontrada para os filtros selecionados.'),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    await waitFor(() => {
      const last = calls(fetchMock).at(-1);
      expect(last?.searchParams.get('status')).toBe('PENDING');
      expect(last?.searchParams.has('subjectType')).toBe(false);
      expect(last?.searchParams.has('q')).toBe(false);
    });
    expect(screen.getByLabelText<HTMLInputElement>('Buscar por código ou título').value).toBe('');
  });

  it('[Validação] período invertido: mostra "O período informado é inválido." e não chama a API', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi();
    renderWithShell(<ApprovalListPage />);
    await screen.findByRole('link', { name: /Abrir Aprovação do DFD 1/ });
    const before = calls(fetchMock).length;
    await user.type(screen.getByLabelText('Solicitada de'), '2026-10-20');
    await waitFor(() => {
      expect(calls(fetchMock).length).toBeGreaterThan(before);
    });
    const afterFrom = calls(fetchMock).length;
    await user.type(screen.getByLabelText('Solicitada até'), '2026-10-01');
    expect((await screen.findByRole('alert')).textContent).toBe('O período informado é inválido.');
    expect(calls(fetchMock).length).toBe(afterFrom);
    expect(
      calls(fetchMock).some((url) => url.searchParams.get('requestedTo') === '2026-10-01'),
    ).toBe(false);
    // A lista anterior continua na tela.
    expect(screen.getByRole('link', { name: /Abrir Aprovação do DFD 1/ })).toBeTruthy();
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
