// @vitest-environment jsdom
import type { ProcessListItemDto, TagDto } from '@contrataflow/validation';
import { act, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { chooseOption } from '@test/support/kit';
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
// A suíte completa roda em paralelo com as demais: o padrão de 5 s é curto para a primeira renderização.
vi.setConfig({ testTimeout: 30_000 });

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

function mockApi(
  list: Handler,
  extra: { me?: Handler; tags?: readonly TagDto[]; permissions?: readonly string[] } = {},
) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(requestUrl(input), 'http://localhost');
    if (url.pathname === '/api/v1/processes') return Promise.resolve(list(url, init));
    if (url.pathname === '/api/v1/me' && extra.me) return Promise.resolve(extra.me(url, init));
    if (url.pathname === '/api/v1/me/permissions') {
      return Promise.resolve(
        jsonResponse({
          data: {
            permissions: (extra.permissions ?? ['PROCESS_CREATE']).map((code) => ({
              code,
              scopes: [{ type: 'TENANT', includeSubtree: false }],
            })),
            implicit: { headOfDepartmentIds: [], ownDepartmentIds: [] },
          },
        }),
      );
    }
    if (url.pathname === '/api/v1/tags') {
      // TAG-01: as inativas só chegam com `includeInactive=true` (quem tem TAG_MANAGE).
      const withInactive = url.searchParams.get('includeInactive') === 'true';
      return Promise.resolve(
        jsonResponse({
          data: (extra.tags ?? []).filter((entry) => withInactive || entry.isActive),
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

const processCalls = (fetchMock: ReturnType<typeof mockApi>) =>
  fetchMock.mock.calls
    .map(([input]) => new URL(requestUrl(input), 'http://localhost'))
    .filter((url) => url.pathname === '/api/v1/processes');
/** Consultas da lista (sem os contadores das abas, que pedem `pageSize=1`). */
const listCalls = (fetchMock: ReturnType<typeof mockApi>) =>
  processCalls(fetchMock).filter((url) => url.searchParams.get('pageSize') !== '1');
/** Contadores das abas (`pageSize=1`). */
const countCalls = (fetchMock: ReturnType<typeof mockApi>) =>
  processCalls(fetchMock).filter((url) => url.searchParams.get('pageSize') === '1');

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
    nav.set('/processos?status=IN_PROGRESS%2CRETURNED&sort=-currentStageDueAt');
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
    const deadline = within(table).getByRole('columnheader', { name: /Prazo da etapa/ });
    expect(deadline.getAttribute('aria-sort')).toBe('descending');
    expect(screen.getByRole('button', { name: /^Ordenar: Prazo da etapa/ }).textContent).toContain(
      'decrescente',
    );
    expect(listCalls(fetchMock)[0]?.searchParams.get('status')).toBe('IN_PROGRESS,RETURNED');
    expect(listCalls(fetchMock)[0]?.searchParams.get('includeStageOptions')).toBe('true');

    // Valor estimado (coluna oculta por padrão) aparece formatado ao ser escolhido.
    await userEvent.click(screen.getByRole('button', { name: 'Colunas' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Valor estimado' }));
    expect(await screen.findByText('R$ 1.200.000,00')).toBeTruthy();
  });

  it('[Sucesso] aba "Atrasados": URL, aba ativa e prazo com ícone e texto', async () => {
    const fetchMock = mockApi((url) =>
      url.searchParams.get('overdue') === 'true' ? page([P45]) : page([item(), P31, P45]),
    );
    renderWithShell(<ProcessListPage />);
    await screen.findByText('0031/2026');
    // Padrão sem parâmetros: "Em andamento" (chip removível).
    expect(listCalls(fetchMock)[0]?.searchParams.get('status')).toBe(
      'DRAFT,IN_PROGRESS,AWAITING_APPROVAL,RETURNED,SUSPENDED',
    );
    const overdue = screen.getByRole('link', { name: /^Atrasados/ });
    expect(overdue.getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('link', { name: /^Todos/ }).getAttribute('aria-current')).toBe('page');
    await userEvent.click(overdue);
    await waitFor(() => {
      expect(screen.queryByText('0031/2026')).toBeNull();
    });
    expect(nav.get()).toContain('overdue=true');
    expect(screen.getByRole('link', { name: /^Atrasados/ }).getAttribute('aria-current')).toBe(
      'page',
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
    expect(screen.getByText('Nenhum processo por aqui')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Buscar em todos os status' }));
    expect(nav.get()).toBe('q=cimento');
    unmount();
    nav.set('/processos');
    mockApi(() => page([]));
    renderWithShell(<ProcessListPage />);
    expect(await screen.findByText('Você ainda não tem processos para acompanhar.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Criar processo' }).getAttribute('href')).toBe(
      '/processos/novo',
    );
    // Cabeçalho: "Novo processo" fica só na barra superior (prd-5 · regra 1); sem PROCESS_EXPORT,
    // sem "Exportar CSV".
    expect(screen.queryByRole('link', { name: 'Novo processo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Exportar CSV' })).toBeNull();
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
    expect(screen.getByRole('button', { name: /Situação: Em andamento/ })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('0012/2026')).toBeTruthy();
  });

  it('[Falha de integração] ME-02 falha: coluna some na hora, fica salva localmente e há aviso', async () => {
    mockApi(() => page([item()]), { me: () => problem(503, 'DEPENDENCY_UNAVAILABLE') });
    renderWithShell(<ProcessListPage />);
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('columnheader', { name: /Situação/ })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Colunas' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Situação' }));
    expect(within(table).queryByRole('columnheader', { name: /Situação/ })).toBeNull();
    expect(
      JSON.parse(localStorage.getItem(columnsPreferenceKey(TENANT_A.id)) ?? '[]'),
    ).not.toContain('status');
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
    await userEvent.click(screen.getByRole('button', { name: /^Filtros/ }));
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
    await chooseOption(userEvent.setup(), 'Responsável', 'Sem responsável', dialog);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Aplicar filtros' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const search = new URLSearchParams(nav.get());
    expect(search.get('estimatedValueMin')).toBe('15000.00');
    expect(search.get('overdue')).toBe('true');
    expect(search.get('currentResponsibleId')).toBe('none');
  });
  it('[Sucesso] US-007: coluna "Etiquetas" com chips (inativa esmaecida) e filtro por etiqueta na URL', async () => {
    const tags: TagDto[] = [
      { id: ID(61), name: 'Obras emergenciais', color: '#B45309', isActive: true, version: 1 },
      { id: ID(62), name: 'Recurso federal', color: '#64748B', isActive: true, version: 1 },
      { id: ID(63), name: 'Antiga', color: '#64748B', isActive: false, version: 2 },
    ];
    mockApi(
      () =>
        page([
          item({
            tags: [
              { id: ID(61), name: 'Obras emergenciais', color: '#B45309', isActive: true },
              { id: ID(63), name: 'Antiga', color: '#64748B', isActive: false },
            ],
          }),
        ]),
      { tags, permissions: ['PROCESS_CREATE', 'TAG_MANAGE'] },
    );
    renderWithShell(<ProcessListPage />);
    const table = await screen.findByRole('table');
    // A coluna não faz parte do padrão: o seletor de colunas a oferece.
    expect(within(table).queryByRole('columnheader', { name: /Etiquetas/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Colunas' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Etiquetas' }));
    expect(within(table).getByRole('columnheader', { name: /Etiquetas/ })).toBeTruthy();
    expect(within(table).getByText('Obras emergenciais')).toBeTruthy();
    expect(within(table).getByText('(inativa)')).toBeTruthy();
    await userEvent.keyboard('{Escape}');

    await userEvent.click(screen.getByRole('button', { name: /^Filtros/ }));
    const dialog = await screen.findByRole('dialog');
    const active = await within(dialog).findByRole('group', { name: 'Etiquetas' });
    expect(within(active).getByRole('checkbox', { name: 'Recurso federal' })).toBeTruthy();
    // Inativas em grupo separado (visível a quem pode listá-las).
    const inactive = await within(dialog).findByRole('group', { name: 'Etiquetas inativas' });
    await userEvent.click(within(active).getByRole('checkbox', { name: 'Obras emergenciais' }));
    await userEvent.click(within(inactive).getByRole('checkbox', { name: 'Antiga' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Aplicar filtros' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(new URLSearchParams(nav.get()).get('tagId')).toBe(`${ID(61)},${ID(63)}`);
    expect(await screen.findByText(/Obras emergenciais, Antiga/)).toBeTruthy();
  });
});

describe('Feature: repaginação da lista (prd-4 · SCR-004)', () => {
  it('[Sucesso] abas com contador por aba, "Mostrando x–y de n" e paginação numerada', async () => {
    const TAB_TOTALS: Record<string, number> = {
      currentResponsibleId: 5,
      currentDepartmentId: 3,
      overdue: 4,
    };
    const fetchMock = mockApi((url) => {
      if (url.searchParams.get('pageSize') === '1') {
        const key = Object.keys(TAB_TOTALS).find((name) => url.searchParams.has(name));
        const returned = url.searchParams.get('status') === 'RETURNED';
        return page([item()], { totalItems: key ? TAB_TOTALS[key] : returned ? 2 : 24 });
      }
      return page([item(), P31], { totalItems: 24, totalPages: 2 });
    });
    renderWithShell(<ProcessListPage />);
    const tabs = await screen.findByRole('navigation', { name: 'Visões da lista' });
    await waitFor(() => {
      expect(within(tabs).getByRole('link', { name: 'Comigo 5' })).toBeTruthy();
    });
    expect(within(tabs).getByRole('link', { name: 'Todos 24' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(within(tabs).getByRole('link', { name: 'Na fila da minha unidade 3' })).toBeTruthy();
    expect(within(tabs).getByRole('link', { name: 'Atrasados 4' })).toBeTruthy();
    expect(within(tabs).getByRole('link', { name: 'Devolvidos 2' })).toBeTruthy();
    // "Acompanhando" não tem filtro na API: não aparece.
    expect(within(tabs).queryByRole('link', { name: /Acompanhando/ })).toBeNull();
    // A aba guarda os demais filtros na URL e troca só o atalho.
    const mine = new URLSearchParams(
      within(tabs).getByRole('link', { name: 'Comigo 5' }).getAttribute('href')?.split('?')[1],
    );
    expect(mine.get('currentResponsibleId')).toBe('me');
    expect(mine.get('status')).toBe('DRAFT,IN_PROGRESS,AWAITING_APPROVAL,RETURNED,SUSPENDED');
    // Contadores: só o total (uma linha, sem ordenação); a aba ativa usa o total da lista.
    expect(countCalls(fetchMock)).toHaveLength(4);
    expect(countCalls(fetchMock).every((url) => !url.searchParams.has('sort'))).toBe(true);

    expect(screen.getByText('Mostrando 1–2 de 24 processos')).toBeTruthy();
    const pagination = screen.getByRole('navigation', { name: 'Paginação' });
    expect(
      within(pagination).getByRole('button', { name: 'Página 1' }).getAttribute('aria-current'),
    ).toBe('page');
    await userEvent.click(within(pagination).getByRole('button', { name: 'Página 2' }));
    expect(new URLSearchParams(nav.get()).get('page')).toBe('2');
  });

  it('[Sucesso] chips removíveis, "Limpar filtros" e menu "Ordenar" com campo e direção', async () => {
    nav.set('/processos?status=RETURNED&overdue=true');
    mockApi(() => page([P31]));
    renderWithShell(<ProcessListPage />);
    await screen.findByText('0031/2026');
    // Dois atalhos ao mesmo tempo (vindos do painel ou de um link): nenhuma aba fica ativa.
    const tabs = screen.getByRole('navigation', { name: 'Visões da lista' });
    expect(within(tabs).queryByRole('link', { current: 'page' })).toBeNull();
    const chips = screen.getByRole('list', { name: 'Filtros ativos' });
    expect(within(chips).getByText('Situação: Devolvido')).toBeTruthy();
    await userEvent.click(
      within(chips).getByRole('button', { name: 'Remover filtro Somente atrasados: Sim' }),
    );
    expect(nav.get()).toBe('status=RETURNED');
    expect(screen.getByRole('link', { name: /^Devolvidos/ }).getAttribute('aria-current')).toBe(
      'page',
    );

    // Padrão `-updatedAt`; escolher "Prazo da etapa" ordena crescente, depois "Decrescente".
    await userEvent.click(screen.getByRole('button', { name: /^Ordenar: Atualizado em/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Prazo da etapa' }));
    expect(new URLSearchParams(nav.get()).get('sort')).toBe('currentStageDueAt');
    await userEvent.click(screen.getByRole('button', { name: /^Ordenar: Prazo da etapa/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Decrescente' }));
    expect(new URLSearchParams(nav.get()).get('sort')).toBe('-currentStageDueAt');

    // Com um chip só, ele mesmo limpa ("Limpar filtros" aparece a partir de dois — FilterToolbar).
    expect(screen.queryByRole('button', { name: 'Limpar filtros' })).toBeNull();
    await userEvent.click(
      within(screen.getByRole('list', { name: 'Filtros ativos' })).getByRole('button', {
        name: 'Remover filtro Situação: Devolvido',
      }),
    );
    expect(nav.get()).toBe('sort=-currentStageDueAt');
  });

  it('[Sucesso] linha: responsável com avatar, tipo/modalidade, prazo colorido, situação e menu ⋯', async () => {
    const today = item({
      id: ID(77),
      code: '0077/2026',
      title: 'Merenda escolar',
      modality: { id: ID(8), code: 'PREGAO_ELETRONICO', label: 'Pregão eletrônico' },
      deadline: { ...item().deadline, daysLeft: 0, isDueSoon: true },
    });
    mockApi(() => page([item(), P31, P45, today]), {
      permissions: ['PROCESS_CREATE', 'PROCESS_EXPORT'],
    });
    renderWithShell(<ProcessListPage />);
    const table = await screen.findByRole('table', { name: 'Processos encontrados' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual([
      'Número',
      'Objeto',
      'Etapa atual',
      'Responsável',
      'Prazo da etapa',
      'Situação',
      'Ações',
    ]);
    const row = (code: string) => within(table).getByText(code).closest('tr') as HTMLElement;
    // Responsável: avatar decorativo com as iniciais + nome; sem responsável, a fila da unidade.
    expect(within(row('0031/2026')).getByText('AS').getAttribute('aria-hidden')).toBe('true');
    expect(within(row('0031/2026')).getByText('Ana Souza')).toBeTruthy();
    expect(
      within(row('0077/2026')).getByText('Pregão eletrônico · Aquisição de bens'),
    ).toBeTruthy();
    expect(within(row('0012/2026')).getByText('Aquisição de bens')).toBeTruthy();
    // Prazo: atrasado em vermelho, "Vence hoje" em âmbar, os demais neutros (texto sempre presente).
    expect(within(row('0045/2026')).getByText('Atrasado há 3 dias úteis').className).toContain(
      'text-destructive',
    );
    expect(within(row('0077/2026')).getByText('Vence hoje').className).toContain('text-warning');
    expect(within(row('0012/2026')).getByText('Vence em 2 dias úteis').className).toContain(
      'text-muted-foreground',
    );
    expect(within(row('0045/2026')).getByText('Aguardando aprovação')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Exportar CSV' })).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);

    await userEvent.click(
      within(row('0045/2026')).getByRole('button', { name: 'Ações de 0045/2026' }),
    );
    expect(
      (await screen.findByRole('menuitem', { name: 'Abrir processo' })).getAttribute('href'),
    ).toBe(`/processos/${ID(45)}`);
    expect(screen.getByRole('menuitem', { name: 'Tramitação' }).getAttribute('href')).toBe(
      `/processos/${ID(45)}?aba=tramitacao`,
    );
  });

  it('[Sucesso] carregando: esqueleto de linhas com anúncio', async () => {
    mockApi(() => new Promise<Response>(() => undefined));
    renderWithShell(<ProcessListPage />);
    expect(await screen.findByText('Carregando processos…')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
