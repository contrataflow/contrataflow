// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import type { ProcessListItemDto, SavedViewDto } from '@contrataflow/validation';
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, problem, renderWithShell, requestUrl } from '@test/support/render';

import { ProcessListPage } from './process-list-page';

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

function view(overrides: Partial<SavedViewDto> = {}): SavedViewDto {
  return {
    id: ID(900),
    name: 'Atrasados por prioridade',
    scope: 'PROCESS_LIST',
    filters: { v: 1, status: ['IN_PROGRESS', 'RETURNED'], overdue: true },
    sort: '-priority',
    columns: ['code', 'title', 'status', 'currentResponsible'],
    isShared: false,
    isDefault: false,
    owner: { id: ID(1), name: 'Patrícia' },
    isOwner: true,
    version: 3,
    ...overrides,
  };
}

const SHARED = view({
  id: ID(901),
  name: 'Devolvidos da Saúde',
  filters: { v: 1, status: ['RETURNED'] },
  sort: null,
  columns: ['code', 'title', 'status', 'priority'],
  isShared: true,
  owner: { id: ID(2), name: 'Beatriz' },
  isOwner: false,
  version: 1,
});

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

interface Env {
  views?: SavedViewDto[];
  permissions?: string[];
  total?: number;
  /** Unidades que existem hoje (DEP-02). */
  units?: { id: string; name: string }[];
  create?: Handler;
  patch?: Handler;
  remove?: Handler;
  export?: Handler;
}

const bodyOf = (init?: RequestInit): Record<string, unknown> =>
  JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
const headerOf = (init: RequestInit | undefined, name: string) =>
  new Headers(init?.headers).get(name);

/** API simulada com o estado das visões (PRC-35..38), a lista (PRC-01) e a exportação (PRC-34). */
function mockApi(env: Env = {}) {
  const state = { views: [...(env.views ?? [])] };
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(requestUrl(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const path = url.pathname;
    const reply = (response: Response | Promise<Response>) => Promise.resolve(response);
    if (path === '/api/v1/processes/export') {
      return reply(env.export?.(url, init) ?? new Response('', { status: 200 }));
    }
    if (path === '/api/v1/processes') {
      const total = env.total ?? 2;
      return reply(
        jsonResponse({
          data: [item(), item({ id: ID(31), code: '0031/2026', title: 'Limpeza hospitalar' })],
          meta: { page: 1, pageSize: 20, totalItems: total, totalPages: 1 },
        }),
      );
    }
    if (path === '/api/v1/saved-views' && method === 'GET') {
      return reply(jsonResponse({ data: state.views }));
    }
    if (path === '/api/v1/saved-views' && method === 'POST') {
      if (env.create) return reply(env.create(url, init));
      const body = bodyOf(init) as Partial<SavedViewDto>;
      const created = view({
        ...body,
        id: ID(950 + state.views.length),
        version: 1,
        isOwner: true,
        owner: { id: ID(1), name: 'Patrícia' },
      });
      state.views = [...state.views, created];
      return reply(jsonResponse({ data: created }, { status: 201, headers: { ETag: '"1"' } }));
    }
    const route = /^\/api\/v1\/saved-views\/([0-9a-f-]{36})$/.exec(path);
    if (route && method === 'PATCH') {
      if (env.patch) return reply(env.patch(url, init));
      const found = state.views.find((candidate) => candidate.id === route[1]);
      if (!found) return reply(problem(404, 'NOT_FOUND'));
      const updated = { ...found, ...bodyOf(init), version: found.version + 1 };
      state.views = state.views.map((candidate) =>
        candidate.id === found.id ? updated : candidate,
      );
      return reply(jsonResponse({ data: updated }));
    }
    if (route && method === 'DELETE') {
      if (env.remove) return reply(env.remove(url, init));
      state.views = state.views.filter((candidate) => candidate.id !== route[1]);
      return reply(new Response(null, { status: 204 }));
    }
    if (path === '/api/v1/me/permissions') {
      return reply(
        jsonResponse({
          data: {
            permissions: (env.permissions ?? []).map((code) => ({
              code,
              scopes: [{ type: 'TENANT', includeSubtree: false }],
            })),
            implicit: { headOfDepartmentIds: [], ownDepartmentIds: [] },
          },
        }),
      );
    }
    if (path === '/api/v1/organizations') {
      return reply(jsonResponse({ data: [{ id: ID(1), shortName: 'PMSJ' }], meta: {} }));
    }
    if (path === '/api/v1/departments/lookup') {
      return reply(jsonResponse({ data: env.units ?? [unit(4, 'Setor de Cotações')] }));
    }
    if (path.startsWith('/api/v1/catalogs/')) {
      return reply(jsonResponse({ data: [{ id: ID(5), label: 'Item' }], meta: {} }));
    }
    return reply(jsonResponse({ data: [], meta: {} }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, state };
}

type Fetch = ReturnType<typeof mockApi>['fetchMock'];

const callsTo = (fetchMock: Fetch, pathname: string, method = 'GET') =>
  fetchMock.mock.calls
    .filter(
      ([input, init]) =>
        new URL(requestUrl(input), 'http://localhost').pathname === pathname &&
        (init?.method ?? 'GET') === method,
    )
    .map(([input, init]) => ({ url: new URL(requestUrl(input), 'http://localhost'), init }));

/** Consultas da lista (sem os contadores das abas, que pedem `pageSize=1`). */
const listCalls = (fetchMock: Fetch) =>
  callsTo(fetchMock, '/api/v1/processes')
    .map((c) => c.url)
    .filter((url) => url.searchParams.get('pageSize') !== '1');

function csvResponse(
  body: BodyInit,
  fileName = 'processos-20261005-1432.csv',
  status = 200,
): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fileName}"`,
    },
  });
}

function problemWithMeta(status: number, code: string, extra: object = {}, headers = {}): Response {
  return new Response(
    JSON.stringify({
      type: `https://docs.contrataflow.com.br/errors/${code.toLowerCase()}`,
      title: code,
      status,
      detail: code,
      instance: '/api/v1/x',
      code,
      correlationId: 'c-test-9',
      errors: [],
      violations: [],
      ...extra,
    }),
    { status, headers: { 'Content-Type': 'application/problem+json', ...headers } },
  );
}

function renderPage() {
  return renderWithShell(
    <>
      <ProcessListPage />
      <Toaster label="Notificações" closeLabel="Fechar" />
    </>,
  );
}

/** A caixa de alerta que contém o texto (para buscar os botões dela). */
function alertBox(node: HTMLElement): HTMLElement {
  const box = node.closest<HTMLElement>('div[role="status"], div[role="alert"]');
  if (box === null) throw new Error('Alerta não encontrado.');
  return box;
}

const select = () => screen.findByRole('combobox', { name: 'Visão' });

async function applyView(id: string) {
  await userEvent.selectOptions(await select(), id);
}

const createObjectURL = vi.fn(() => 'blob:x');
let downloads: string[] = [];

beforeEach(() => {
  nav.set('/processos?status=IN_PROGRESS');
  nav.push.mockClear();
  nav.replace.mockClear();
  localStorage.clear();
  downloads = [];
  createObjectURL.mockClear();
  // jsdom não implementa URL de objeto nem o clique em âncora com `download`.
  Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(
    this: HTMLAnchorElement,
  ) {
    downloads.push(this.download);
  });
});
afterEach(() => {
  clearToasts();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Feature: salvar visão (US-003 · PRC-36)', () => {
  it('[Sucesso] salva a visão com Idempotency-Key, critérios atuais e a deixa aplicada', async () => {
    nav.set('/processos?status=IN_PROGRESS%2CRETURNED&overdue=true&sort=-priority');
    const { fetchMock } = mockApi();
    renderPage();
    await screen.findByText('0012/2026');
    // Sem visões: orientação do estado vazio.
    expect(
      await screen.findByText(
        'Você ainda não salvou visões. Ajuste os filtros e clique em Salvar visão.',
      ),
    ).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Salvar visão' }));
    const dialog = await screen.findByRole('dialog', { name: 'Salvar visão' });
    expect(
      within(dialog).getByText(/Atrasados · Ordenação: Prioridade \(decrescente\)/),
    ).toBeTruthy();
    await userEvent.type(
      within(dialog).getByLabelText('Nome da visão *'),
      '  Atrasados por prioridade ',
    );
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /Usar como visão padrão/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const [post] = callsTo(fetchMock, '/api/v1/saved-views', 'POST');
    expect(headerOf(post?.init, 'Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(bodyOf(post?.init)).toEqual({
      scope: 'PROCESS_LIST',
      name: 'Atrasados por prioridade',
      filters: { v: 1, status: ['IN_PROGRESS', 'RETURNED'], overdue: true },
      sort: '-priority',
      columns: ['code', 'title', 'stage', 'currentResponsible', 'deadline', 'status'],
      isShared: false,
      isDefault: true,
    });
    // A visão nova fica aplicada: chip de origem e seletor nela, sem "Alterações não salvas".
    expect(await screen.findByText('Visão: Atrasados por prioridade')).toBeTruthy();
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Visão' }).value).not.toBe('');
    expect(screen.queryByText('Alterações não salvas')).toBeNull();
    expect(await screen.findByText('Visão Atrasados por prioridade salva.')).toBeTruthy();
  });

  it('[Validação] nome vazio ou com 81 caracteres não é enviado (V-01)', async () => {
    const { fetchMock } = mockApi();
    renderPage();
    await screen.findByText('0012/2026');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar visão' }));
    const dialog = await screen.findByRole('dialog', { name: 'Salvar visão' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(within(dialog).getByText('Informe um nome de até 80 caracteres.')).toBeTruthy();
    const input = within(dialog).getByLabelText('Nome da visão *');
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(input, { target: { value: 'a'.repeat(81) } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(within(dialog).getByText('Informe um nome de até 80 caracteres.')).toBeTruthy();
    expect(callsTo(fetchMock, '/api/v1/saved-views', 'POST')).toHaveLength(0);
  });

  it('[Duplicidade] 409: erro no campo Nome e o diálogo continua aberto', async () => {
    mockApi({ create: () => problem(409, 'CONFLICT') });
    renderPage();
    await screen.findByText('0012/2026');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar visão' }));
    const dialog = await screen.findByRole('dialog', { name: 'Salvar visão' });
    await userEvent.type(within(dialog).getByLabelText('Nome da visão *'), 'Atrasados');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(await within(dialog).findByText('Você já tem uma visão com este nome.')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Salvar visão' })).toBeTruthy();
    expect(within(dialog).getByLabelText('Nome da visão *').getAttribute('aria-invalid')).toBe(
      'true',
    );
  });

  it('[Validação] 422: erro por campo no Nome e mensagem geral (limite de 20) no topo', async () => {
    let attempt = 0;
    mockApi({
      create: () => {
        attempt += 1;
        return attempt === 1
          ? problemWithMeta(422, 'VALIDATION_ERROR', {
              errors: [
                {
                  field: 'name',
                  code: 'TOO_LONG',
                  message: 'Informe um nome de até 80 caracteres.',
                },
              ],
            })
          : problemWithMeta(422, 'VALIDATION_ERROR', {
              errors: [
                {
                  field: 'scope',
                  code: 'INVALID_FORMAT',
                  message:
                    'Você atingiu o limite de 20 visões. Exclua uma visão para salvar outra.',
                },
              ],
            });
      },
    });
    renderPage();
    await screen.findByText('0012/2026');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar visão' }));
    const dialog = await screen.findByRole('dialog', { name: 'Salvar visão' });
    await userEvent.type(within(dialog).getByLabelText('Nome da visão *'), 'Atrasados');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(await within(dialog).findByText('Informe um nome de até 80 caracteres.')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(
      await within(dialog).findByText(
        'Você atingiu o limite de 20 visões. Exclua uma visão para salvar outra.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Salvar visão' })).toBeTruthy();
  });

  it('[Duplicidade] indisponível: reenvio do mesmo pedido usa a mesma Idempotency-Key', async () => {
    let calls = 0;
    const { fetchMock } = mockApi({
      create: (_url, init) => {
        calls += 1;
        if (calls <= 4) return problem(503, 'DEPENDENCY_UNAVAILABLE');
        const created = view({
          ...(bodyOf(init) as Partial<SavedViewDto>),
          id: ID(960),
          version: 1,
        });
        return jsonResponse({ data: created }, { status: 201 });
      },
    });
    renderPage();
    await screen.findByText('0012/2026');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar visão' }));
    const dialog = await screen.findByRole('dialog', { name: 'Salvar visão' });
    await userEvent.type(within(dialog).getByLabelText('Nome da visão *'), 'Atrasados');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(
      await within(dialog).findByText(
        'Não foi possível concluir agora. Tente novamente em instantes.',
      ),
    ).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const keys = callsTo(fetchMock, '/api/v1/saved-views', 'POST').map((call) =>
      headerOf(call.init, 'Idempotency-Key'),
    );
    expect(keys).toHaveLength(5);
    expect(new Set(keys).size).toBe(1);
  });

  it('[Acessibilidade] foco volta ao gatilho ao fechar e o diálogo não tem violações sérias', async () => {
    mockApi();
    renderPage();
    await screen.findByText('0012/2026');
    const trigger = screen.getByRole('button', { name: 'Salvar visão' });
    await userEvent.click(trigger);
    await screen.findByRole('dialog', { name: 'Salvar visão' });
    expect(await seriousA11yViolations()).toEqual([]);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });
});

describe('Feature: aplicar visão (US-003)', () => {
  it('[Sucesso] escolher a visão escreve filtros e ordenação na URL e aplica as colunas', async () => {
    const { fetchMock } = mockApi({ views: [view(), SHARED] });
    renderPage();
    await screen.findByText('0012/2026');
    // Colunas da tela antes: inclui Etapa (Secretaria saiu do padrão — prd-5 · regra 3).
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: /Etapa/ })).toBeTruthy();

    const picker = await select();
    const groups = Array.from(picker.querySelectorAll('optgroup')).map((group) => group.label);
    expect(groups).toEqual(['Minhas visões', 'Compartilhadas']);
    expect(
      within(picker).getByRole('option', { name: 'Devolvidos da Saúde (de Beatriz)' }),
    ).toBeTruthy();

    await userEvent.selectOptions(picker, ID(900));
    const search = new URLSearchParams(nav.get());
    expect(search.get('status')).toBe('IN_PROGRESS,RETURNED');
    expect(search.get('overdue')).toBe('true');
    expect(search.get('sort')).toBe('-priority');
    await waitFor(() => {
      expect(listCalls(fetchMock).some((url) => url.searchParams.get('overdue') === 'true')).toBe(
        true,
      );
    });
    // Colunas da visão: code, title, status, responsible — sem Secretaria nem Etapa.
    await waitFor(() => {
      expect(within(table).queryByRole('columnheader', { name: /Etapa/ })).toBeNull();
    });
    expect(within(table).queryByRole('columnheader', { name: /Secretaria/ })).toBeNull();
    expect(within(table).getByRole('columnheader', { name: /Responsável/ })).toBeTruthy();
    expect(within(table).queryByRole('columnheader', { name: /Etapa/ })).toBeNull();
    expect(screen.getByText('Visão: Atrasados por prioridade')).toBeTruthy();
    expect(screen.queryByText('Alterações não salvas')).toBeNull();
    // Aplicar não grava a preferência de colunas do usuário.
    expect(localStorage.length).toBe(0);
  });

  it('[Sucesso] "Limpar" solta a visão e volta ao padrão da tela e às colunas do usuário', async () => {
    mockApi({ views: [view()] });
    renderPage();
    await screen.findByText('0012/2026');
    await applyView(ID(900));
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Limpar a visão Atrasados por prioridade e voltar ao padrão da tela',
      }),
    );
    expect(screen.queryByText('Visão: Atrasados por prioridade')).toBeNull();
    expect(new URLSearchParams(nav.get()).get('status')).toBe(
      'DRAFT,IN_PROGRESS,AWAITING_APPROVAL,RETURNED,SUSPENDED',
    );
    expect(new URLSearchParams(nav.get()).get('overdue')).toBeNull();
    expect(
      within(screen.getByRole('table')).getByRole('columnheader', { name: /Etapa/ }),
    ).toBeTruthy();
  });

  it('[Sucesso] visão padrão: abrir /processos sem parâmetros aplica a visão (uma só consulta)', async () => {
    nav.set('/processos');
    const { fetchMock } = mockApi({ views: [view({ isDefault: true }), SHARED] });
    renderPage();
    expect(await screen.findByText('Visão: Atrasados por prioridade')).toBeTruthy();
    await screen.findByText('0012/2026');
    expect(nav.replace).toHaveBeenCalledWith(expect.stringContaining('overdue=true'), {
      scroll: false,
    });
    expect(nav.push).not.toHaveBeenCalled();
    // A lista não é consultada com o padrão da tela antes da visão.
    const calls = listCalls(fetchMock);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((url) => url.searchParams.get('overdue') === 'true')).toBe(true);
    expect(
      within(screen.getByRole('table')).queryByRole('columnheader', { name: /Etapa/ }),
    ).toBeNull();
  });

  it('[Concorrência] escolher a visão antes de as opções dos filtros chegarem não a solta (sem padrão)', async () => {
    nav.set('/processos');
    const { fetchMock } = mockApi({ views: [view()] });
    // As unidades chegam depois da escolha, e a navegação do `push` ainda não trocou a URL.
    const { promise: unitsArrived, resolve: releaseUnits } = Promise.withResolvers<undefined>();
    const mocked = fetchMock.getMockImplementation();
    if (mocked === undefined) throw new Error('mockApi sem implementação.');
    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(requestUrl(input), 'http://localhost').pathname;
      if (path === '/api/v1/departments/lookup') await unitsArrived;
      return mocked(input, init);
    });
    nav.push.mockImplementationOnce(() => undefined);
    renderPage();
    await screen.findByRole('option', { name: 'Atrasados por prioridade' });
    await applyView(ID(900));
    expect(screen.getByText('Visão: Atrasados por prioridade')).toBeTruthy();

    releaseUnits(undefined);
    await waitFor(() => {
      expect(callsTo(fetchMock, '/api/v1/departments/lookup').length).toBeGreaterThan(0);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByText('Visão: Atrasados por prioridade')).toBeTruthy();
  });

  it('[Sucesso] a visão padrão de outro dono não é aplicada e a URL com parâmetros é respeitada', async () => {
    nav.set('/processos');
    const { fetchMock } = mockApi({
      views: [{ ...SHARED, isDefault: true }],
    });
    const { unmount } = renderPage();
    await screen.findByText('0012/2026');
    expect(nav.replace).not.toHaveBeenCalled();
    expect(listCalls(fetchMock)[0]?.searchParams.get('status')).toBe(
      'DRAFT,IN_PROGRESS,AWAITING_APPROVAL,RETURNED,SUSPENDED',
    );
    unmount();

    nav.set('/processos?priority=URGENT');
    mockApi({ views: [view({ isDefault: true })] });
    renderPage();
    await screen.findByText('0012/2026');
    expect(nav.replace).not.toHaveBeenCalled();
    expect(screen.queryByText('Visão: Atrasados por prioridade')).toBeNull();
  });

  it('[Sucesso] listar as visões falhou: a tela continua e oferece tentar de novo', async () => {
    const { fetchMock } = mockApi();
    const base = fetchMock.getMockImplementation();
    let failing = true;
    fetchMock.mockImplementation((input, init) => {
      const url = new URL(requestUrl(input), 'http://localhost');
      if (url.pathname === '/api/v1/saved-views' && failing) {
        return Promise.resolve(problem(503, 'DEPENDENCY_UNAVAILABLE'));
      }
      return base ? base(input, init) : Promise.reject(new Error('sem mock'));
    });
    renderPage();
    expect(await screen.findByText('Não foi possível carregar as visões.')).toBeTruthy();
    expect(await screen.findByText('0012/2026')).toBeTruthy();
    failing = false;
    await userEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(
      await screen.findByText(
        'Você ainda não salvou visões. Ajuste os filtros e clique em Salvar visão.',
      ),
    ).toBeTruthy();
  });

  it('[Filtros desatualizados] descarta unidade removida, mantém as existentes e avisa (FA-05)', async () => {
    const stale = view({
      filters: { v: 1, currentDepartmentId: [ID(4), ID(99)], overdue: true },
      sort: null,
    });
    mockApi({ views: [stale] });
    renderPage();
    await screen.findByText('0012/2026');
    await applyView(stale.id);
    const search = new URLSearchParams(nav.get());
    expect(search.get('currentDepartmentId')).toBe(ID(4));
    expect(search.get('overdue')).toBe('true');
    expect(
      await screen.findByText(
        'Alguns filtros desta visão não estão mais disponíveis e foram ignorados.',
      ),
    ).toBeTruthy();
    // A visão salva não muda sozinha: a diferença aparece como alteração não salva.
    expect(screen.getByText('Alterações não salvas')).toBeTruthy();
  });

  it('[Filtros desatualizados] todas as unidades removidas: filtro some da URL, aviso aparece', async () => {
    const stale = view({ filters: { v: 1, requestingSecretariatId: [ID(98)] }, sort: null });
    mockApi({ views: [stale] });
    renderPage();
    await screen.findByText('0012/2026');
    await applyView(stale.id);
    expect(new URLSearchParams(nav.get()).get('requestingSecretariatId')).toBeNull();
    expect(
      await screen.findByText(
        'Alguns filtros desta visão não estão mais disponíveis e foram ignorados.',
      ),
    ).toBeTruthy();
  });
});

describe('Feature: alterações não salvas (US-003 · FA-02)', () => {
  it('[Sucesso] "Atualizar visão" envia PATCH com If-Match e some o indicador', async () => {
    const { fetchMock } = mockApi({ views: [view()] });
    renderPage();
    await screen.findByText('0012/2026');
    await applyView(ID(900));
    expect(screen.queryByText('Alterações não salvas')).toBeNull();

    await userEvent.click(screen.getByRole('link', { name: /^Devolvidos/ }));
    expect(await screen.findByText('Alterações não salvas')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Atualizar visão' }));

    await waitFor(() => {
      expect(screen.queryByText('Alterações não salvas')).toBeNull();
    });
    const [patch] = callsTo(fetchMock, `/api/v1/saved-views/${ID(900)}`, 'PATCH');
    expect(headerOf(patch?.init, 'If-Match')).toBe('"3"');
    expect(bodyOf(patch?.init)).toEqual({
      // As abas são exclusivas: "Devolvidos" tira o atalho "Atrasados" da visão.
      filters: { v: 1, status: ['RETURNED'] },
      sort: '-priority',
      columns: ['code', 'title', 'currentResponsible', 'status'],
    });
    expect(await screen.findByText('Visão Atrasados por prioridade atualizada.')).toBeTruthy();
  });

  it('[Sucesso] mudar uma coluna também conta como alteração e "Salvar como nova" abre o diálogo', async () => {
    mockApi({ views: [view()] });
    renderPage();
    await screen.findByText('0012/2026');
    await applyView(ID(900));
    await userEvent.click(screen.getByRole('button', { name: 'Colunas' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Prioridade' }));
    expect(await screen.findByText('Alterações não salvas')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Salvar como nova' }));
    expect(await screen.findByRole('dialog', { name: 'Salvar visão' })).toBeTruthy();
  });

  it('[Concorrência] 412: oferece "Recarregar a visão" e "Salvar como nova"; recarregar reaplica a versão do servidor', async () => {
    const { fetchMock, state } = mockApi({
      views: [view()],
      patch: () => problem(412, 'VERSION_CONFLICT'),
    });
    renderPage();
    await screen.findByText('0012/2026');
    await applyView(ID(900));
    await userEvent.click(screen.getByRole('link', { name: /^Devolvidos/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Atualizar visão' }));

    const alert = await screen.findByText('Esta visão foi alterada em outra janela.');
    const box = alertBox(alert);
    expect(within(box).getByRole('button', { name: 'Salvar como nova' })).toBeTruthy();

    // Outra janela mudou a visão: a versão do servidor passa a ser a 4.
    state.views = [view({ version: 4, filters: { v: 1, status: ['SUSPENDED'] }, sort: null })];
    await userEvent.click(within(box).getByRole('button', { name: 'Recarregar a visão' }));
    await waitFor(() => {
      expect(new URLSearchParams(nav.get()).get('status')).toBe('SUSPENDED');
    });
    expect(screen.queryByText('Esta visão foi alterada em outra janela.')).toBeNull();
    expect(callsTo(fetchMock, '/api/v1/saved-views').length).toBeGreaterThanOrEqual(2);
    expect(new URLSearchParams(nav.get()).get('overdue')).toBeNull();
    expect(screen.queryByText('Alterações não salvas')).toBeNull();
  });

  it('[Permissão] 403 ao atualizar: mostra a regra e oferece "Salvar como minha"', async () => {
    mockApi({ views: [view()], patch: () => problem(403, 'PERMISSION_DENIED') });
    renderPage();
    await screen.findByText('0012/2026');
    await applyView(ID(900));
    await userEvent.click(screen.getByRole('link', { name: /^Devolvidos/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Atualizar visão' }));
    const message = await screen.findByText('Somente quem criou a visão pode alterá-la.');
    const box = alertBox(message);
    await userEvent.click(within(box).getByRole('button', { name: 'Salvar como minha' }));
    expect(await screen.findByRole('dialog', { name: 'Salvar como minha visão' })).toBeTruthy();
  });

  it('[Concorrência] 404 ao atualizar: a visão sai do seletor e a lista de visões é recarregada', async () => {
    const { fetchMock, state } = mockApi({
      views: [view()],
      patch: () => problem(404, 'NOT_FOUND'),
    });
    renderPage();
    await screen.findByText('0012/2026');
    await applyView(ID(900));
    await userEvent.click(screen.getByRole('link', { name: /^Devolvidos/ }));
    state.views = [];
    await userEvent.click(await screen.findByRole('button', { name: 'Atualizar visão' }));
    expect(await screen.findByText('Visão não encontrada.')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText('Visão: Atrasados por prioridade')).toBeNull();
    });
    expect(callsTo(fetchMock, '/api/v1/saved-views').length).toBeGreaterThanOrEqual(2);
    await userEvent.click(screen.getByRole('button', { name: 'Dispensar' }));
    expect(screen.queryByText('Visão não encontrada.')).toBeNull();
  });
});

describe('Feature: visão compartilhada por outro dono (US-003 · FA-04)', () => {
  it('[Permissão] pode aplicar e copiar, mas não atualizar, renomear nem excluir', async () => {
    const { fetchMock } = mockApi({ views: [view(), SHARED] });
    renderPage();
    await screen.findByText('0012/2026');
    await applyView(SHARED.id);
    expect(new URLSearchParams(nav.get()).get('status')).toBe('RETURNED');
    await userEvent.click(screen.getByRole('link', { name: /^Atrasados/ }));
    expect(await screen.findByText('Alterações não salvas')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Atualizar visão' })).toBeNull();

    // "Gerenciar visões" só lista as visões próprias.
    await userEvent.click(screen.getByRole('button', { name: 'Ações da visão' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Gerenciar visões' }));
    const manage = await screen.findByRole('dialog', { name: 'Gerenciar visões' });
    expect(within(manage).getByText('Atrasados por prioridade')).toBeTruthy();
    expect(within(manage).queryByText('Devolvidos da Saúde')).toBeNull();
    expect(
      within(manage).queryByRole('button', { name: /Renomear a visão Devolvidos/ }),
    ).toBeNull();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    // "Salvar como minha": cópia via POST com os critérios atuais.
    await userEvent.click(screen.getByRole('button', { name: 'Salvar como minha' }));
    const dialog = await screen.findByRole('dialog', { name: 'Salvar como minha visão' });
    expect(within(dialog).getByLabelText<HTMLInputElement>('Nome da visão *').value).toBe(
      'Devolvidos da Saúde',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const [post] = callsTo(fetchMock, '/api/v1/saved-views', 'POST');
    expect(bodyOf(post?.init)).toMatchObject({
      name: 'Devolvidos da Saúde',
      // A aba "Atrasados" substituiu o atalho "Devolvidos" da visão (abas exclusivas).
      filters: { v: 1, overdue: true },
      isShared: false,
      isDefault: false,
    });
    expect(callsTo(fetchMock, `/api/v1/saved-views/${SHARED.id}`, 'PATCH')).toHaveLength(0);
    expect(callsTo(fetchMock, `/api/v1/saved-views/${SHARED.id}`, 'DELETE')).toHaveLength(0);
    expect(await screen.findByText('Visão: Devolvidos da Saúde')).toBeTruthy();
  });
});

describe('Feature: gerenciar visões (US-003 · FA-03)', () => {
  const second = view({ id: ID(902), name: 'Minha fila', version: 2, filters: { v: 1 } });

  async function openManage() {
    await screen.findByText('0012/2026');
    await userEvent.click(await screen.findByRole('button', { name: 'Ações da visão' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Gerenciar visões' }));
    return screen.findByRole('dialog', { name: 'Gerenciar visões' });
  }

  it('[Sucesso] renomeia, define o padrão e exclui com confirmação (If-Match da versão lida)', async () => {
    const { fetchMock } = mockApi({ views: [view({ isDefault: true }), second] });
    nav.set('/processos?status=RETURNED');
    renderPage();
    const dialog = await openManage();
    expect(await seriousA11yViolations()).toEqual([]);

    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Renomear a visão Minha fila' }),
    );
    const input = within(dialog).getByLabelText('Novo nome da visão Minha fila');
    await userEvent.clear(input);
    await userEvent.type(input, 'Fila da semana');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar nome' }));
    expect(await within(dialog).findByText('Fila da semana')).toBeTruthy();
    const [rename] = callsTo(fetchMock, `/api/v1/saved-views/${ID(902)}`, 'PATCH');
    expect(headerOf(rename?.init, 'If-Match')).toBe('"2"');
    expect(bodyOf(rename?.init)).toEqual({ name: 'Fila da semana' });

    // Trocar a padrão: a anterior deixa de ser padrão.
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Usar a visão Fila da semana como padrão' }),
    );
    await waitFor(() => {
      expect(
        within(dialog).getByRole('button', { name: 'Remover o padrão da visão Fila da semana' }),
      ).toBeTruthy();
    });
    expect(
      within(dialog).getByRole('button', {
        name: 'Usar a visão Atrasados por prioridade como padrão',
      }),
    ).toBeTruthy();
    const [setDefault] = callsTo(fetchMock, `/api/v1/saved-views/${ID(902)}`, 'PATCH').slice(-1);
    expect(bodyOf(setDefault?.init)).toEqual({ isDefault: true });

    // Excluir pede confirmação.
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Excluir a visão Fila da semana' }),
    );
    expect(
      within(dialog).getByText('Excluir a visão Fila da semana? Esta ação não pode ser desfeita.'),
    ).toBeTruthy();
    expect(callsTo(fetchMock, `/api/v1/saved-views/${ID(902)}`, 'DELETE')).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Excluir visão' }));
    await waitFor(() => {
      expect(within(dialog).queryByText('Fila da semana')).toBeNull();
    });
    const [remove] = callsTo(fetchMock, `/api/v1/saved-views/${ID(902)}`, 'DELETE');
    // Renomear (v3) e trocar o padrão (v4): o DELETE usa a versão mais recente lida.
    expect(headerOf(remove?.init, 'If-Match')).toBe('"4"');
  });

  it('[Duplicidade] renomear para um nome existente mostra o erro no campo', async () => {
    mockApi({ views: [view(), second], patch: () => problem(409, 'CONFLICT') });
    renderPage();
    const dialog = await openManage();
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Renomear a visão Minha fila' }),
    );
    const input = within(dialog).getByLabelText('Novo nome da visão Minha fila');
    await userEvent.clear(input);
    await userEvent.type(input, 'atrasados por PRIORIDADE');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar nome' }));
    expect(await within(dialog).findByText('Você já tem uma visão com este nome.')).toBeTruthy();
    expect(within(dialog).getByLabelText('Novo nome da visão Minha fila')).toBeTruthy();
  });

  it('[Concorrência] 412 ao excluir: avisa e recarrega a lista de visões', async () => {
    const { fetchMock } = mockApi({
      views: [view(), second],
      remove: () => problem(412, 'VERSION_CONFLICT'),
    });
    renderPage();
    const dialog = await openManage();
    const before = callsTo(fetchMock, '/api/v1/saved-views').length;
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Excluir a visão Minha fila' }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Excluir visão' }));
    expect(
      await within(dialog).findByText('Esta visão foi alterada em outra janela.'),
    ).toBeTruthy();
    await waitFor(() => {
      expect(callsTo(fetchMock, '/api/v1/saved-views').length).toBeGreaterThan(before);
    });
  });

  it('[Sucesso] excluir a visão aplicada solta o chip de origem', async () => {
    mockApi({ views: [view()] });
    renderPage();
    await screen.findByText('0012/2026');
    await applyView(ID(900));
    expect(await screen.findByText('Visão: Atrasados por prioridade')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Ações da visão' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Gerenciar visões' }));
    const dialog = await screen.findByRole('dialog', { name: 'Gerenciar visões' });
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Excluir a visão Atrasados por prioridade' }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Excluir visão' }));
    expect(await within(dialog).findByText('Você ainda não tem visões próprias.')).toBeTruthy();
    expect(screen.queryByText('Visão: Atrasados por prioridade')).toBeNull();
  });
});

describe('Feature: exportar CSV (US-003 · PRC-34)', () => {
  const CSV = '\uFEFFCódigo;Título\r\n0012/2026;Cimento\r\n0031/2026;"Limpeza;\r\nhospitalar"\r\n';

  it('[Permissão] o botão e o item de menu só existem com PROCESS_EXPORT', async () => {
    const { fetchMock } = mockApi({ views: [view()], permissions: ['PROCESS_CREATE'] });
    const { unmount } = renderPage();
    await screen.findByText('0012/2026');
    await waitFor(() => {
      expect(callsTo(fetchMock, '/api/v1/me/permissions').length).toBeGreaterThan(0);
    });
    await select();
    expect(screen.queryByRole('button', { name: 'Exportar CSV' })).toBeNull();
    await applyView(ID(900));
    await userEvent.click(screen.getByRole('button', { name: 'Ações da visão' }));
    expect(await screen.findByRole('menuitem', { name: 'Gerenciar visões' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Exportar CSV' })).toBeNull();
    unmount();

    mockApi({ permissions: ['PROCESS_EXPORT'] });
    renderPage();
    expect(await screen.findByRole('button', { name: 'Exportar CSV' })).toBeTruthy();
  });

  it('[Sucesso] mostra total e colunas, baixa o arquivo, anuncia a conclusão e fecha', async () => {
    const { fetchMock } = mockApi({
      permissions: ['PROCESS_EXPORT'],
      total: 137,
      export: () => csvResponse(CSV),
    });
    renderPage();
    await screen.findByText('0012/2026');
    await userEvent.click(await screen.findByRole('button', { name: 'Exportar CSV' }));
    const dialog = await screen.findByRole('dialog', { name: 'Exportar CSV' });
    expect(await within(dialog).findByText('137 processos na consulta atual')).toBeTruthy();
    const columns = within(dialog).getByRole('list', { name: 'Colunas do arquivo' });
    expect(
      within(columns)
        .getAllByRole('listitem')
        .map((node) => node.textContent),
    ).toEqual(['Número', 'Objeto', 'Etapa atual', 'Responsável', 'Prazo da etapa', 'Situação']);
    expect(await seriousA11yViolations()).toEqual([]);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Exportar' }));
    expect(await screen.findByText('Exportação concluída: 2 processos.')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const [call] = callsTo(fetchMock, '/api/v1/processes/export');
    const query = call?.url.searchParams;
    expect(query?.get('status')).toBe('IN_PROGRESS');
    expect(query?.get('columns')).toBe('code,title,stage,currentResponsible,deadline,status');
    expect(query?.has('page')).toBe(false);
    expect(query?.has('savedViewId')).toBe(false);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(downloads).toEqual(['processos-20261005-1432.csv']);
  });

  it('[Sucesso] a exportação segue a ordem e a seleção de colunas da tela e cita a visão de origem', async () => {
    const { fetchMock } = mockApi({
      views: [view()],
      permissions: ['PROCESS_EXPORT'],
      export: () => csvResponse(CSV),
    });
    renderPage();
    await screen.findByText('0012/2026');
    await applyView(ID(900));
    await userEvent.click(await screen.findByRole('button', { name: 'Exportar CSV' }));
    const dialog = await screen.findByRole('dialog', { name: 'Exportar CSV' });
    await waitFor(() => {
      expect(
        within(dialog).getByRole('button', { name: 'Exportar' }).hasAttribute('disabled'),
      ).toBe(false);
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Exportar' }));
    await waitFor(() => {
      expect(callsTo(fetchMock, '/api/v1/processes/export')).toHaveLength(1);
    });
    const query = callsTo(fetchMock, '/api/v1/processes/export')[0]?.url.searchParams;
    expect(query?.get('columns')).toBe('code,title,currentResponsible,status');
    expect(query?.get('overdue')).toBe('true');
    expect(query?.get('sort')).toBe('-priority');
    expect(query?.get('savedViewId')).toBe(ID(900));
  });

  it('[Sucesso] FA-06: "Exportar CSV" do menu reaplica a visão e abre o diálogo', async () => {
    mockApi({ views: [view()], permissions: ['PROCESS_EXPORT'], export: () => csvResponse(CSV) });
    renderPage();
    await screen.findByText('0012/2026');
    await applyView(ID(900));
    await userEvent.click(screen.getByRole('link', { name: /^Devolvidos/ }));
    expect(await screen.findByText('Alterações não salvas')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Ações da visão' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Exportar CSV' }));
    expect(await screen.findByRole('dialog', { name: 'Exportar CSV' })).toBeTruthy();
    await waitFor(() => {
      expect(new URLSearchParams(nav.get()).get('status')).toBe('IN_PROGRESS,RETURNED');
    });
    await waitFor(() => {
      expect(screen.queryByText('Alterações não salvas')).toBeNull();
    });
  });

  it('[Validação] acima de 10.000 linhas: aviso para refinar e botão desabilitado (FA-07)', async () => {
    const { fetchMock } = mockApi({ permissions: ['PROCESS_EXPORT'], total: 10_240 });
    renderPage();
    await screen.findByText('0012/2026');
    await userEvent.click(await screen.findByRole('button', { name: 'Exportar CSV' }));
    const dialog = await screen.findByRole('dialog', { name: 'Exportar CSV' });
    expect(
      await within(dialog).findByText(
        'A consulta tem 10.240 processos. Refine os filtros para exportar até 10.000.',
      ),
    ).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Exportar' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(callsTo(fetchMock, '/api/v1/processes/export')).toHaveLength(0);
  });

  it('[Validação] 422 EXPORT_TOO_LARGE depois de abrir: usa o total da API e bloqueia o botão', async () => {
    mockApi({
      permissions: ['PROCESS_EXPORT'],
      total: 137,
      export: () => problemWithMeta(422, 'EXPORT_TOO_LARGE', { meta: { totalItems: 10_240 } }),
    });
    renderPage();
    await screen.findByText('0012/2026');
    await userEvent.click(await screen.findByRole('button', { name: 'Exportar CSV' }));
    const dialog = await screen.findByRole('dialog', { name: 'Exportar CSV' });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Exportar' }));
    expect(
      await within(dialog).findByText(
        'A consulta tem 10.240 processos. Refine os filtros para exportar até 10.000.',
      ),
    ).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Exportar' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('[Falha] conexão interrompida: descarta o arquivo parcial e permite tentar de novo (FA-08)', async () => {
    let attempt = 0;
    mockApi({
      permissions: ['PROCESS_EXPORT'],
      export: () => {
        attempt += 1;
        if (attempt === 1) {
          const broken = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error('reset'));
            },
          });
          return csvResponse(broken);
        }
        return csvResponse(CSV);
      },
    });
    renderPage();
    await screen.findByText('0012/2026');
    await userEvent.click(await screen.findByRole('button', { name: 'Exportar CSV' }));
    const dialog = await screen.findByRole('dialog', { name: 'Exportar CSV' });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Exportar' }));
    expect(
      await within(dialog).findByText('A exportação foi interrompida. Tente novamente.'),
    ).toBeTruthy();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(downloads).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('Exportação concluída: 2 processos.')).toBeTruthy();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('[Concorrência] 429: pede para aguardar e respeita o Retry-After (FA-09)', async () => {
    mockApi({
      permissions: ['PROCESS_EXPORT'],
      export: () => problemWithMeta(429, 'RATE_LIMITED', {}, { 'Retry-After': '30' }),
    });
    renderPage();
    await screen.findByText('0012/2026');
    await userEvent.click(await screen.findByRole('button', { name: 'Exportar CSV' }));
    const dialog = await screen.findByRole('dialog', { name: 'Exportar CSV' });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Exportar' }));
    expect(
      await within(dialog).findByText('Aguarde a exportação em andamento terminar.'),
    ).toBeTruthy();
    expect(within(dialog).getByText('Tente novamente em 30 segundos.')).toBeTruthy();
    expect(
      within(dialog).getByRole('button', { name: 'Tentar novamente' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('[Falha de banco] 503 antes do envio: mensagem, código de correlação e nova tentativa', async () => {
    mockApi({
      permissions: ['PROCESS_EXPORT'],
      export: () => problem(503, 'DEPENDENCY_UNAVAILABLE', 'corr-503'),
    });
    renderPage();
    await screen.findByText('0012/2026');
    await userEvent.click(await screen.findByRole('button', { name: 'Exportar CSV' }));
    const dialog = await screen.findByRole('dialog', { name: 'Exportar CSV' });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Exportar' }));
    expect(
      await within(dialog).findByText(
        'Não foi possível exportar agora. Tente novamente em instantes.',
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText('Código: corr-503')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Tentar novamente' })).toBeTruthy();
  });

  it('[Permissão] 403 na exportação: mensagem de permissão e botão bloqueado', async () => {
    mockApi({ permissions: ['PROCESS_EXPORT'], export: () => problem(403, 'PERMISSION_DENIED') });
    renderPage();
    await screen.findByText('0012/2026');
    await userEvent.click(await screen.findByRole('button', { name: 'Exportar CSV' }));
    const dialog = await screen.findByRole('dialog', { name: 'Exportar CSV' });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Exportar' }));
    expect(
      await within(dialog).findByText('Você não tem permissão para exportar processos.'),
    ).toBeTruthy();
  });

  it('[Sucesso] "Cancelar exportação" aborta o fetch e volta ao estado inicial sem erro', async () => {
    let aborted = false;
    mockApi({
      permissions: ['PROCESS_EXPORT'],
      export: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    });
    renderPage();
    await screen.findByText('0012/2026');
    await userEvent.click(await screen.findByRole('button', { name: 'Exportar CSV' }));
    const dialog = await screen.findByRole('dialog', { name: 'Exportar CSV' });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Exportar' }));
    expect(await within(dialog).findByRole('progressbar')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancelar exportação' }));
    await waitFor(() => {
      expect(aborted).toBe(true);
    });
    expect(within(dialog).queryByRole('progressbar')).toBeNull();
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Exportar' })).toBeTruthy();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('[Acessibilidade] foco volta ao botão "Exportar CSV" ao fechar o diálogo', async () => {
    mockApi({ permissions: ['PROCESS_EXPORT'] });
    renderPage();
    await screen.findByText('0012/2026');
    const trigger = await screen.findByRole('button', { name: 'Exportar CSV' });
    await userEvent.click(trigger);
    await screen.findByRole('dialog', { name: 'Exportar CSV' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });
});
