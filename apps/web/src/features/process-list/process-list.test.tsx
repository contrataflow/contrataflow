// @vitest-environment jsdom
import type { ProcessListItemDto } from '@contrataflow/validation';
import { act, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, problem, renderWithShell, requestUrl, TENANT_A } from '@test/support/render';

import { ProcessListPage } from './process-list-page';
import {
  DEFAULT_LIST_PARAMS,
  clearFilters,
  primarySort,
  resolveListState,
  searchValue,
  toApiQuery,
  toSearchString,
  toggleQuickFilter,
  toggleSort,
  withParam,
} from './process-list-state';
import { columnsPreferenceKey } from './process-list.api';

configure({ asyncUtilTimeout: 5_000 });

/** Navegação simulada: a URL é estado observável (`useSearchParams`) e o roteador a altera. */
const nav = vi.hoisted(() => {
  let search = '';
  const listeners = new Set<() => void>();
  const set = (href: string) => {
    search = href.includes('?') ? (href.split('?')[1] ?? '') : '';
    listeners.forEach((listener) => {
      listener();
    });
  };
  return {
    get: () => search,
    set,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    push: vi.fn((href: string) => {
      set(href);
    }),
    replace: vi.fn((href: string) => {
      set(href);
    }),
  };
});

vi.mock('next/navigation', async () => {
  const React = await import('react');
  return {
    usePathname: () => '/processos',
    useRouter: () => ({ push: nav.push, replace: nav.replace, refresh: vi.fn() }),
    useSearchParams: () => {
      const search = React.useSyncExternalStore(nav.subscribe, nav.get, nav.get);
      return React.useMemo(() => new URLSearchParams(search), [search]);
    },
  };
});

const ID = (n: number) => `0192a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const unit = (n: number, name: string) => ({ id: ID(n), name });

function item(overrides: Partial<ProcessListItemDto> = {}): ProcessListItemDto {
  return {
    id: ID(12),
    code: '0012/2026',
    number: 12,
    year: 2026,
    internalCode: null,
    title: 'Aquisição de cimento para manutenção de vias',
    status: 'IN_PROGRESS',
    priority: 'HIGH',
    organization: { id: ID(1), shortName: 'PMSJ' },
    requestingSecretariat: unit(2, 'Secretaria de Obras'),
    requestingDepartment: unit(3, 'Setor de Manutenção'),
    currentStage: { key: 'PESQUISA_PRECOS', name: 'Pesquisa de preços' },
    currentDepartment: unit(4, 'Setor de Cotações'),
    currentResponsible: null,
    deadline: {
      dueAt: '2026-10-08T02:59:59Z',
      slaType: 'BUSINESS',
      daysLeft: 2,
      overdueDays: null,
      isDueSoon: true,
      isOverdue: false,
      isPaused: false,
    },
    contractingType: { id: ID(5), code: 'AQUISICAO_BENS', label: 'Aquisição de bens' },
    modality: null,
    origin: { id: ID(6), code: 'DEMANDA_NAO_PREVISTA', label: 'Demanda não prevista' },
    isBudgetConfidential: false,
    estimatedValue: '85000.00',
    estimatedValueMasked: false,
    targetDate: '2026-11-30',
    overdueSince: null,
    tags: [],
    openedAt: null,
    createdAt: '2026-09-14T13:02:11Z',
    updatedAt: '2026-10-02T18:40:00Z',
    ...overrides,
  };
}

const P31 = item({
  id: ID(31),
  code: '0031/2026',
  title: 'Contratação de limpeza hospitalar',
  status: 'RETURNED',
  priority: 'MEDIUM',
  currentResponsible: unit(7, 'Ana Souza'),
  isBudgetConfidential: true,
  estimatedValue: '1200000.00',
});
const P45 = item({
  id: ID(45),
  code: '0045/2026',
  title: 'Aquisição de medicamentos da farmácia básica',
  status: 'AWAITING_APPROVAL',
  priority: 'URGENT',
  deadline: {
    dueAt: '2026-10-01T02:59:59Z',
    slaType: 'BUSINESS',
    daysLeft: null,
    overdueDays: 3,
    isDueSoon: false,
    isOverdue: true,
    isPaused: false,
  },
});

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function mockApi(list: Handler, extra: { me?: Handler } = {}) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(requestUrl(input), 'http://localhost');
    if (url.pathname === '/api/v1/processes') return Promise.resolve(list(url, init));
    if (url.pathname === '/api/v1/me' && extra.me) return Promise.resolve(extra.me(url, init));
    if (url.pathname === '/api/v1/me/permissions') {
      return Promise.resolve(
        jsonResponse({
          data: {
            permissions: [
              { code: 'PROCESS_CREATE', scopes: [{ type: 'TENANT', includeSubtree: false }] },
            ],
            implicit: { headOfDepartmentIds: [], ownDepartmentIds: [] },
          },
        }),
      );
    }
    if (url.pathname === '/api/v1/organizations') {
      return Promise.resolve(jsonResponse({ data: [{ id: ID(1), shortName: 'PMSJ' }], meta: {} }));
    }
    if (url.pathname === '/api/v1/departments/lookup') {
      return Promise.resolve(jsonResponse({ data: [unit(4, 'Setor de Cotações')] }));
    }
    return Promise.resolve(jsonResponse({ data: [], meta: { page: 1, totalItems: 0 } }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const page = (data: ProcessListItemDto[], meta: Record<string, unknown> = {}) =>
  jsonResponse({
    data,
    meta: { page: 1, pageSize: 20, totalItems: data.length, totalPages: 1, ...meta },
  });

const listCalls = (fetchMock: ReturnType<typeof mockApi>) =>
  fetchMock.mock.calls
    .map(([input]) => new URL(requestUrl(input), 'http://localhost'))
    .filter((url) => url.pathname === '/api/v1/processes');

beforeEach(() => {
  nav.set('/processos');
  nav.push.mockClear();
  nav.replace.mockClear();
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('estado da URL (US-002 · SCR-004)', () => {
  it('sem parâmetros aplica "Em andamento" (RN-PROC-30); inválidos são descartados (FA-03)', () => {
    expect(resolveListState(new URLSearchParams(''))).toEqual({
      params: DEFAULT_LIST_PARAMS,
      hadInvalid: false,
      usedDefaults: true,
    });
    expect(resolveListState(new URLSearchParams('status=OPEN&priority=HIGH&foo=1'))).toEqual({
      params: { priority: 'HIGH' },
      hadInvalid: true,
      usedDefaults: false,
    });
    expect(resolveListState(new URLSearchParams('status=RETURNED&status=DRAFT')).params).toEqual({
      status: 'RETURNED,DRAFT',
    });
  });

  it('URL com filtros antes da ordenação; mudanças voltam à página 1', () => {
    const params = withParam({ status: 'IN_PROGRESS,RETURNED', page: '3' }, 'sort', '-priority');
    expect(toSearchString(params)).toBe('status=IN_PROGRESS%2CRETURNED&sort=-priority');
    expect(toSearchString({})).toBe('page=1');
    expect(withParam({ page: '2' }, 'page', '3')).toEqual({ page: '3' });
    expect(
      toApiQuery({ q: 'abc', includeStageOptions: 'true' }, { includeStageOptions: true }),
    ).toEqual({
      q: 'abc',
      includeStageOptions: 'true',
    });
  });

  it('atalhos substituem o valor do filtro e desligam ao clicar de novo (RN-PROC-24)', () => {
    const mine = toggleQuickFilter({ currentResponsibleId: 'none' }, 'mine');
    expect(mine).toEqual({ currentResponsibleId: 'me' });
    expect(toggleQuickFilter(mine, 'mine')).toEqual({});
    expect(toggleQuickFilter({ status: 'DRAFT' }, 'returned')).toEqual({ status: 'RETURNED' });
    expect(clearFilters({ status: 'DRAFT', sort: 'code', pageSize: '50' })).toEqual({
      sort: 'code',
      pageSize: '50',
    });
  });

  it('ordenação pelo cabeçalho e busca mínima (RN-PROC-27 · V-03)', () => {
    expect(primarySort({})).toEqual({ field: 'updatedAt', direction: 'desc' });
    expect(primarySort({ q: 'cimento' })).toBeNull();
    expect(toggleSort({}, 'priority').sort).toBe('priority');
    expect(toggleSort({ sort: 'priority' }, 'priority').sort).toBe('-priority');
    expect(searchValue(' a ')).toEqual({ value: undefined, tooShort: true });
    expect(searchValue('  ')).toEqual({ value: undefined, tooShort: false });
    expect(searchValue(' 12/2026 ')).toEqual({ value: '12/2026', tooShort: false });
  });
});

describe('Feature: SCR-004 — Processos (US-002)', () => {
  it('[Sucesso] filtros e ordenação: tabela, total anunciado, valor sigiloso visível e URL', async () => {
    nav.set('/processos?status=IN_PROGRESS%2CRETURNED&sort=-priority');
    const fetchMock = mockApi(() => page([item(), P31]));
    renderWithShell(<ProcessListPage />);
    const table = await screen.findByRole('table', { name: 'Processos encontrados' });
    expect(within(table).getByRole('link', { name: '0012/2026' }).getAttribute('href')).toBe(
      `/processos/${ID(12)}`,
    );
    expect(screen.getByRole('status', { name: '' }).textContent).toContain(
      '2 processos encontrados',
    );
    const row = within(table).getByText('Contratação de limpeza hospitalar').closest('tr');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('Orçamento sigiloso')).toBeTruthy();
    expect(within(row as HTMLElement).getByText('Ana Souza')).toBeTruthy();
    expect(within(table).getByText('Na fila de Setor de Cotações')).toBeTruthy();
    expect(within(table).getAllByText('Vence em 2 dias úteis')).toHaveLength(2);
    const priority = within(table).getByRole('columnheader', { name: /Prioridade/ });
    expect(priority.getAttribute('aria-sort')).toBe('descending');
    expect(listCalls(fetchMock)[0]?.searchParams.get('status')).toBe('IN_PROGRESS,RETURNED');
    expect(listCalls(fetchMock)[0]?.searchParams.get('includeStageOptions')).toBe('true');

    // Valor estimado (coluna oculta por padrão) aparece formatado ao ser escolhido.
    await userEvent.click(screen.getByRole('button', { name: 'Colunas' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Valor estimado' }));
    expect(await screen.findByText('R$ 1.200.000,00')).toBeTruthy();
  });

  it('[Sucesso] atalho "Atrasados": URL, aria-pressed e badge com ícone e texto', async () => {
    const fetchMock = mockApi((url) =>
      url.searchParams.get('overdue') === 'true' ? page([P45]) : page([item(), P31, P45]),
    );
    renderWithShell(<ProcessListPage />);
    await screen.findByText('0031/2026');
    // Padrão sem parâmetros: "Em andamento" (chip removível).
    expect(listCalls(fetchMock)[0]?.searchParams.get('status')).toBe(
      'DRAFT,IN_PROGRESS,AWAITING_APPROVAL,RETURNED,SUSPENDED',
    );
    const overdue = screen.getByRole('button', { name: 'Atrasados' });
    expect(overdue.getAttribute('aria-pressed')).toBe('false');
    await userEvent.click(overdue);
    await waitFor(() => {
      expect(screen.queryByText('0031/2026')).toBeNull();
    });
    expect(nav.get()).toContain('overdue=true');
    expect(screen.getByRole('button', { name: 'Atrasados' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    const badge = screen.getByText('Atrasado há 3 dias úteis');
    expect(badge.querySelector('svg')).not.toBeNull();
  });

  it('[Sucesso] "Comigo" mostra o link das aprovações pendentes (FA-11); chip removível', async () => {
    nav.set('/processos?currentResponsibleId=me');
    mockApi(() => page([P31]));
    renderWithShell(<ProcessListPage />);
    expect(
      await screen.findByRole('link', { name: 'Ver minhas aprovações pendentes' }),
    ).toBeTruthy();
    const chip = screen.getByRole('button', { name: 'Remover filtro Responsável: Eu' });
    await userEvent.click(chip);
    expect(nav.get()).toBe('page=1');
  });

  it('[Validação] busca curta não consulta; busca válida espera 300 ms e usa replace', async () => {
    const fetchMock = mockApi(() => page([item()]));
    renderWithShell(<ProcessListPage />);
    await screen.findByText('0012/2026');
    const before = listCalls(fetchMock).length;
    const input = screen.getByRole('searchbox', { name: 'Buscar processos' });
    fireEvent.change(input, { target: { value: 'a' } });
    expect(screen.getByText('Digite ao menos 2 caracteres para buscar.')).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(listCalls(fetchMock)).toHaveLength(before);
    fireEvent.change(input, { target: { value: '12/2026' } });
    await waitFor(() => {
      expect(nav.replace).toHaveBeenCalledWith(expect.stringContaining('q=12%2F2026'), {
        scroll: false,
      });
    });
    await waitFor(() => {
      expect(listCalls(fetchMock).some((url) => url.searchParams.get('q') === '12/2026')).toBe(
        true,
      );
    });
  });

  it('[Validação] link com filtros inválidos: aviso e URL corrigida (FA-03)', async () => {
    nav.set('/processos?status=OPEN&priority=HIGH');
    mockApi(() => page([item()]));
    renderWithShell(<ProcessListPage />);
    expect(
      await screen.findByText('Alguns filtros do link eram inválidos e foram ignorados.'),
    ).toBeTruthy();
    expect(nav.replace).toHaveBeenCalledWith('/processos?priority=HIGH', { scroll: false });
  });

  it('[Permissão] valor mascarado "Sigiloso" e nota do filtro por valor (FA-05/FA-06)', async () => {
    nav.set('/processos?estimatedValueMin=1000000.00');
    localStorage.setItem(columnsPreferenceKey(TENANT_A.id), JSON.stringify(['estimatedValue']));
    mockApi(() =>
      page([{ ...P31, estimatedValue: null, estimatedValueMasked: true }], {
        valueFilterExcludesConfidential: true,
      }),
    );
    renderWithShell(<ProcessListPage />);
    expect(await screen.findByText('Sigiloso')).toBeTruthy();
    expect(
      screen.getByText(
        'Processos com orçamento sigiloso que você não pode ver não entram no filtro por valor.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /Valor estimado mínimo: R\$ 1\.000\.000,00/ }),
    ).toBeTruthy();
  });

  it('[Permissão] step-up de MFA para valores sigilosos (FA-12) e 403 → SCR-111', async () => {
    mockApi(() => page([P31], { confidentialStepUpAvailable: true }));
    const { unmount } = renderWithShell(<ProcessListPage />);
    expect(
      await screen.findByText('Confirme sua identidade para ver valores sigilosos.'),
    ).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Confirmar identidade' }).getAttribute('href'),
    ).toContain('/api/auth/step-up?returnTo=');
    unmount();
    mockApi(() => problem(403, 'PERMISSION_DENIED'));
    renderWithShell(<ProcessListPage />);
    expect(await screen.findByRole('heading', { name: 'Acesso negado' })).toBeTruthy();
    expect(screen.getByText('Você não tem acesso à lista de processos.')).toBeTruthy();
  });

  it('[Sucesso] nenhum resultado com filtros e nenhum processo visível (FA-01/FA-02)', async () => {
    nav.set('/processos?q=cimento&status=COMPLETED');
    mockApi(() => page([]));
    const { unmount } = renderWithShell(<ProcessListPage />);
    expect(await screen.findByText('Nenhum processo encontrado com estes filtros.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Buscar em todos os status' }));
    expect(nav.get()).toBe('q=cimento');
    unmount();
    nav.set('/processos');
    mockApi(() => page([]));
    renderWithShell(<ProcessListPage />);
    expect(await screen.findByText('Você ainda não tem processos para acompanhar.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Novo processo' })).toBeTruthy();
  });

  it('[Falha de banco] 503: mantém filtros, mensagem com correlationId e "Tentar novamente"', async () => {
    nav.set('/processos?status=IN_PROGRESS');
    let calls = 0;
    mockApi(() => {
      calls += 1;
      return calls === 1 ? problem(503, 'DEPENDENCY_UNAVAILABLE', 'corr-503') : page([item()]);
    });
    renderWithShell(<ProcessListPage />);
    expect(
      await screen.findByText(
        'Não foi possível carregar os processos agora. Tente novamente em instantes.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Código: corr-503')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Status: Em andamento/ })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('0012/2026')).toBeTruthy();
  });

  it('[Falha de integração] ME-02 falha: coluna some na hora, fica salva localmente e há aviso', async () => {
    mockApi(() => page([item()]), { me: () => problem(503, 'DEPENDENCY_UNAVAILABLE') });
    renderWithShell(<ProcessListPage />);
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('columnheader', { name: /Prioridade/ })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Colunas' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Prioridade' }));
    expect(within(table).queryByRole('columnheader', { name: /Prioridade/ })).toBeNull();
    expect(
      JSON.parse(localStorage.getItem(columnsPreferenceKey(TENANT_A.id)) ?? '[]'),
    ).not.toContain('priority');
    expect(
      await screen.findByText(
        'Não foi possível salvar suas colunas neste dispositivo para outros acessos.',
      ),
    ).toBeTruthy();
  });

  it('[Sucesso] painel de filtros aplica na URL e recusa intervalo inválido (V-06/V-07)', async () => {
    mockApi(() => page([item()]));
    renderWithShell(<ProcessListPage />);
    await screen.findByText('0012/2026');
    await userEvent.click(screen.getByRole('button', { name: 'Filtros' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Valor estimado mínimo'), {
      target: { value: '10,999' },
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Aplicar filtros' }));
    expect(
      within(dialog).getByText('Informe valores válidos, com até 2 casas decimais.'),
    ).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Valor estimado mínimo'), {
      target: { value: '15.000,00' },
    });
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Somente atrasados' }));
    await userEvent.selectOptions(within(dialog).getByLabelText('Responsável'), 'none');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Aplicar filtros' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const search = new URLSearchParams(nav.get());
    expect(search.get('estimatedValueMin')).toBe('15000.00');
    expect(search.get('overdue')).toBe('true');
    expect(search.get('currentResponsibleId')).toBe('none');
  });
});
