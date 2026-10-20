// @vitest-environment jsdom
import type {
  DashboardSummaryDto,
  DashboardWidgetDto,
  DashboardWidgetKey,
  DepartmentDto,
} from '@contrataflow/validation';
import { DASHBOARD_WIDGET_KEYS } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, problem, renderWithShell, requestUrl } from '@test/support/render';

import { DashboardPage } from './dashboard-page';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

/*
 * US-076 — SCR-003 (`/painel`): resumo (DSH-01) e cartões independentes (DSH-02) com carregamento,
 * vazio e erro próprios, filtros na URL, atalhos para a lista/caixa, POL-09 no agregado, 403 e
 * acessibilidade (axe).
 */

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
    replace: vi.fn((href: string) => {
      set(href);
    }),
  };
});

vi.mock('next/navigation', async () => {
  const React = await import('react');
  return {
    usePathname: () => '/painel',
    useRouter: () => ({ push: nav.replace, replace: nav.replace, refresh: vi.fn() }),
    useSearchParams: () => {
      const search = React.useSyncExternalStore(nav.subscribe, nav.get, nav.get);
      return React.useMemo(() => new URLSearchParams(search), [search]);
    },
  };
});

const ID = (n: number) => `0192e076-0000-7000-8000-${String(n).padStart(12, '0')}`;
const OBRAS = ID(1);
const MANUT = ID(2);
const SAUDE = ID(3);
const AT = '2026-10-20T15:00:00.000Z';

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
    createdAt: AT,
    updatedAt: AT,
    version: 1,
    ...patch,
  };
}

const UNITS = [
  unit(OBRAS, 'Secretaria de Obras'),
  unit(MANUT, 'Setor de Manutenção', {
    parentId: OBRAS,
    type: 'SECTOR',
    isSecretariat: false,
    path: `/${OBRAS}/${MANUT}/`,
    depth: 1,
  }),
  unit(SAUDE, 'Secretaria de Saúde'),
];

const SUMMARY: DashboardSummaryDto = {
  pendingCount: 14,
  overdueCount: 3,
  dueSoonCount: 5,
  openCount: 42,
  generatedAt: AT,
};

const series = (...values: [string, string | null, number][]) =>
  values.map(([key, label, value]) => ({ key, label, value }));

const WIDGETS: Record<DashboardWidgetKey, DashboardWidgetDto> = {
  PENDING_ITEMS: {
    widgetKey: 'PENDING_ITEMS',
    total: 14,
    series: series(['MINE', null, 12], ['PENDING_APPROVALS', null, 2]) as never,
    generatedAt: AT,
  },
  BY_STATUS: {
    widgetKey: 'BY_STATUS',
    total: 44,
    series: series(['IN_PROGRESS', null, 42], ['DRAFT', null, 2]) as never,
    generatedAt: AT,
  },
  BY_STAGE: {
    widgetKey: 'BY_STAGE',
    total: 42,
    series: series([ID(50), 'Estudos preliminares', 42]),
    generatedAt: AT,
  },
  OVERDUE: {
    widgetKey: 'OVERDUE',
    total: 3,
    series: series([OBRAS, 'Secretaria de Obras', 3]),
    generatedAt: AT,
  },
  DUE_SOON: {
    widgetKey: 'DUE_SOON',
    total: 0,
    warnBeforeBusinessDays: 2,
    series: [],
    generatedAt: AT,
  },
  AVG_STAGE_DURATION: {
    widgetKey: 'AVG_STAGE_DURATION',
    windowDays: 90,
    series: [{ key: ID(50), label: 'Estudos preliminares', value: 3 * 86_400, sampleSize: 4 }],
    generatedAt: AT,
  },
  OPENED_BY_MONTH: {
    widgetKey: 'OPENED_BY_MONTH',
    total: 43,
    series: series(['2026-09', null, 0], ['2026-10', null, 43]),
    generatedAt: AT,
  },
  VALUE_BY_SECRETARIAT: {
    widgetKey: 'VALUE_BY_SECRETARIAT',
    series: [
      {
        key: OBRAS,
        label: 'Secretaria de Obras',
        value: '1250000.00',
        confidentialExcluded: false,
      },
      { key: SAUDE, label: 'Secretaria de Saúde', value: '320000.00', confidentialExcluded: true },
    ],
    generatedAt: AT,
  },
  RECENT_ACTIVITY: {
    widgetKey: 'RECENT_ACTIVITY',
    items: [
      {
        id: ID(70),
        occurredAt: AT,
        type: 'PROCESS_CREATED',
        actorType: 'USER',
        actorId: ID(80),
        actorName: 'Ana Souza',
        actorDepartmentName: null,
        entityType: null,
        entityId: null,
        movementId: null,
        params: {},
        visibility: 'STANDARD',
        process: { id: ID(60), code: '0030/2026' },
      },
    ],
    generatedAt: AT,
  },
};

interface MockOptions {
  readonly permissions?: readonly string[];
  readonly summary?: (url: URL) => Response;
  readonly widget?: (key: string, url: URL) => Response | undefined;
}

function mockApi(options: MockOptions = {}) {
  const permissions = options.permissions ?? ['DASHBOARD_VIEW', 'INBOX_VIEW'];
  const fetchMock = vi.fn<typeof fetch>((input) => {
    const url = new URL(requestUrl(input), 'http://localhost');
    if (url.pathname === '/api/v1/me/permissions') {
      return Promise.resolve(
        jsonResponse({
          data: {
            permissions: permissions.map((code) => ({
              code,
              scopes: [{ type: 'TENANT', includeSubtree: false }],
            })),
            implicit: { headOfDepartmentIds: [], ownDepartmentIds: [] },
          },
        }),
      );
    }
    if (url.pathname === '/api/v1/departments') {
      return Promise.resolve(
        jsonResponse({
          data: UNITS,
          meta: { page: 1, pageSize: 100, totalItems: UNITS.length, totalPages: 1 },
        }),
      );
    }
    if (url.pathname === '/api/v1/dashboard/summary') {
      return Promise.resolve(
        options.summary?.(url) ??
          jsonResponse({
            data: SUMMARY,
            meta: { cache: { hit: false, expiresAt: '2026-10-20T15:01:00.000Z' } },
          }),
      );
    }
    const match = /^\/api\/v1\/dashboard\/widgets\/([A-Z_]+)$/.exec(url.pathname);
    if (match?.[1]) {
      const key = match[1] as DashboardWidgetKey;
      return Promise.resolve(
        options.widget?.(key, url) ??
          jsonResponse({
            data: WIDGETS[key],
            meta: { generatedAt: AT, cache: { hit: false, expiresAt: AT } },
          }),
      );
    }
    return Promise.resolve(problem(404, 'NOT_FOUND'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const calls = (fetchMock: ReturnType<typeof mockApi>, pathname: string) =>
  fetchMock.mock.calls
    .map(([input]) => new URL(requestUrl(input), 'http://localhost'))
    .filter((url) => url.pathname === pathname);

async function card(title: string): Promise<HTMLElement> {
  const region = (await screen.findByRole('heading', { name: title })).closest<HTMLElement>(
    'article, section',
  );
  if (region === null) throw new Error(`Cartão "${title}" não encontrado.`);
  return region;
}

beforeEach(() => {
  nav.set('/painel');
  nav.replace.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SCR-003 — Painel (US-076)', () => {
  it('[Sucesso] resumo com atalhos, os 9 indicadores em cartões e a atividade recente — sem violação de a11y', async () => {
    const fetchMock = mockApi();
    renderWithShell(<DashboardPage />);
    const overdue = await screen.findByRole('link', {
      name: 'Atrasados: 3 processos. Ver a lista.',
    });
    expect(overdue.getAttribute('href')).toContain('overdue=true');
    expect(
      screen
        .getByRole('link', { name: 'Pendências: 14 processos. Ver a lista.' })
        .getAttribute('href'),
    ).toBe('/tarefas');
    expect(screen.getByRole('link', { name: 'Abertos: 42 processos. Ver a lista.' })).toBeTruthy();
    // Cada indicador é uma requisição própria (DSH-02).
    await waitFor(() => {
      for (const key of DASHBOARD_WIDGET_KEYS) {
        expect(calls(fetchMock, `/api/v1/dashboard/widgets/${key}`)).toHaveLength(1);
      }
    });
    const status = await card('Processos por situação');
    expect(await within(status).findByRole('link', { name: /Em andamento\s*42/ })).toBeTruthy();
    const average = await card('Tempo médio por etapa (90 dias)');
    expect(await within(average).findByText('3 dias')).toBeTruthy();
    expect(within(average).getByText('4 passagens')).toBeTruthy();
    const activity = await card('Atividade recente');
    expect(
      (await within(activity).findByRole('link', { name: 'Processo 0030/2026' })).getAttribute(
        'href',
      ),
    ).toBe(`/processos/${ID(60)}`);
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('[Permissão] valor por secretaria: total parcial com o selo "Valores sigilosos não somados"', async () => {
    mockApi();
    renderWithShell(<DashboardPage />);
    const value = await card('Valor estimado por secretaria');
    const saude = await within(value).findByRole('link', { name: /Secretaria de Saúde/ });
    expect(saude.textContent).toContain('R$');
    expect(within(value).getByText('Valores sigilosos não somados')).toBeTruthy();
    // Só um grupo tem exclusão.
    expect(within(value).getAllByText('Valores sigilosos não somados')).toHaveLength(1);
  });

  it('dados do gráfico também em tabela (alternância acessível)', async () => {
    mockApi();
    renderWithShell(<DashboardPage />);
    const stage = await card('Abertos por etapa');
    const toggle = await within(stage).findByRole('button', { name: 'Ver como tabela' });
    await userEvent.click(toggle);
    const table = within(stage).getByRole('table', {
      name: 'Abertos por etapa (dados do gráfico)',
    });
    expect(within(table).getByRole('rowheader', { name: 'Estudos preliminares' })).toBeTruthy();
    expect(
      within(stage).getByRole('button', { name: 'Ver como gráfico' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('FA-01: estados vazios contextuais por cartão', async () => {
    mockApi();
    renderWithShell(<DashboardPage />);
    const dueSoon = await card('Próximos do prazo por secretaria');
    expect(
      await within(dueSoon).findByText('Nenhum processo vencendo nos próximos 2 dias úteis.'),
    ).toBeTruthy();
  });

  it('filtro de secretaria/unidade: URL atualizada e cartões reconsultados com o recorte', async () => {
    const fetchMock = mockApi();
    renderWithShell(<DashboardPage />);
    const secretariat = await screen.findByRole('combobox', { name: 'Secretaria' });
    await screen.findByRole('option', { name: 'Secretaria de Obras' });
    await userEvent.selectOptions(secretariat, OBRAS);
    expect(nav.replace).toHaveBeenLastCalledWith(`/painel?secretariatId=${OBRAS}`, {
      scroll: false,
    });
    const department = screen.getByRole('combobox', { name: 'Unidade/Setor' });
    // Só a subárvore da secretaria escolhida.
    expect(
      within(department)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Todas', 'Setor de Manutenção']);
    await userEvent.selectOptions(department, MANUT);
    expect(nav.replace).toHaveBeenLastCalledWith(
      `/painel?secretariatId=${OBRAS}&departmentId=${MANUT}`,
      { scroll: false },
    );
    await waitFor(() => {
      const last = calls(fetchMock, '/api/v1/dashboard/widgets/BY_STATUS').at(-1);
      expect(last?.searchParams.get('departmentId')).toBe(MANUT);
    });
    expect(
      calls(fetchMock, '/api/v1/dashboard/summary').at(-1)?.searchParams.get('secretariatId'),
    ).toBe(OBRAS);
    // O atalho do resumo leva o recorte para a lista de processos.
    expect((await screen.findByRole('link', { name: /Atrasados/ })).getAttribute('href')).toContain(
      `requestingSecretariatId=${OBRAS}`,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    expect(nav.replace).toHaveBeenLastCalledWith('/painel', { scroll: false });
  });

  it('FA-05: um cartão com erro mostra "Tentar novamente" sem afetar os demais', async () => {
    let failures = 1;
    const fetchMock = mockApi({
      widget: (key) => {
        if (key !== 'BY_STAGE' || failures === 0) return undefined;
        failures -= 1;
        return problem(503, 'DEPENDENCY_UNAVAILABLE');
      },
    });
    renderWithShell(<DashboardPage />);
    const stage = await card('Abertos por etapa');
    const alert = await within(stage).findByRole('alert');
    expect(alert.textContent).toContain('Não foi possível carregar os indicadores agora.');
    // Os demais seguem carregados.
    expect(await screen.findByRole('link', { name: /Em andamento\s*42/ })).toBeTruthy();
    await userEvent.click(within(stage).getByRole('button', { name: 'Tentar novamente' }));
    expect(await within(stage).findByText('Estudos preliminares')).toBeTruthy();
    expect(calls(fetchMock, '/api/v1/dashboard/widgets/BY_STAGE')).toHaveLength(2);
  });

  it('erro inesperado (500) traz o código copiável', async () => {
    mockApi({
      widget: (key) =>
        key === 'OVERDUE' ? problem(500, 'INTERNAL_ERROR', 'c-dash-500') : undefined,
    });
    renderWithShell(<DashboardPage />);
    const overdue = await card('Atrasados por secretaria');
    expect(await within(overdue).findByText('Código: c-dash-500')).toBeTruthy();
  });

  it('referência de filtro inválida (422) volta os filtros para "Todas"', async () => {
    nav.set(`/painel?secretariatId=${ID(77)}`);
    mockApi({
      summary: (url) =>
        url.searchParams.get('secretariatId') === ID(77)
          ? new Response(
              JSON.stringify({
                type: 'x',
                title: 'VALIDATION_ERROR',
                status: 422,
                detail: 'x',
                instance: '/api/v1/dashboard/summary',
                code: 'VALIDATION_ERROR',
                correlationId: 'c',
                errors: [{ field: 'secretariatId', code: 'REFERENCE_NOT_FOUND', message: 'x' }],
                violations: [],
              }),
              { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
            )
          : jsonResponse({ data: SUMMARY, meta: { cache: { hit: true, expiresAt: AT } } }),
    });
    renderWithShell(<DashboardPage />);
    await waitFor(() => {
      expect(nav.replace).toHaveBeenCalledWith('/painel', { scroll: false });
    });
  });

  it('[Permissão] sem DASHBOARD_VIEW: estado 403 e nenhuma consulta ao painel', async () => {
    const fetchMock = mockApi({ permissions: ['INBOX_VIEW'] });
    renderWithShell(<DashboardPage />);
    expect(await screen.findByText('Você não tem permissão para acessar o painel.')).toBeTruthy();
    expect(calls(fetchMock, '/api/v1/dashboard/summary')).toHaveLength(0);
  });
});
