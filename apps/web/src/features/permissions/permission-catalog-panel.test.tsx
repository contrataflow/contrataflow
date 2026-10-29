// @vitest-environment jsdom
import { PERMISSIONS } from '@contrataflow/types';
import type { PermissionDto } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { PermissionCatalogPanel } from './permission-catalog-panel';

// A suíte completa roda em paralelo com as demais; o padrão de 1 s é curto para a primeira renderização.
configure({ asyncUtilTimeout: 5000 });

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => '/admin/perfis',
}));

const CATALOG: PermissionDto[] = PERMISSIONS.map((permission) => ({ ...permission }));

function problemResponse(status: number, code: string, detail: string): Response {
  return new Response(
    JSON.stringify({
      type: `https://docs.contrataflow.com.br/errors/${code.toLowerCase()}`,
      title: code,
      status,
      detail,
      instance: '/api/v1/permissions',
      code,
      correlationId: 'c-test',
      errors: [],
      violations: [],
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

function mockApi(list: () => Response = () => jsonResponse({ data: CATALOG, meta: {} })) {
  const fetchMock = vi.fn<typeof fetch>((input) => {
    const url = requestUrl(input);
    if (url.startsWith('/api/v1/me/permissions')) {
      return Promise.resolve(
        jsonResponse({ data: { permissions: [{ code: 'ROLE_VIEW', scopes: [] }] } }),
      );
    }
    if (url === '/api/v1/permissions') return Promise.resolve(list());
    return Promise.resolve(problemResponse(404, 'NOT_FOUND', 'x'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const catalogCalls = (api: ReturnType<typeof mockApi>) =>
  api.mock.calls.filter(([input]) => requestUrl(input) === '/api/v1/permissions');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[Sucesso] catálogo de permissões agrupado por módulo', () => {
  it('renderiza os 69 itens do catálogo, agrupados e com a contagem por módulo', async () => {
    const api = mockApi();
    renderWithShell(<PermissionCatalogPanel />);

    expect(await screen.findByRole('heading', { name: 'Catálogo de permissões' })).toBeTruthy();
    await screen.findByText('Visualizar processos');

    expect(CATALOG).toHaveLength(69);
    expect(screen.getAllByRole('listitem', { hidden: true })).toHaveLength(69);
    expect(screen.getByText('69 permissões')).toBeTruthy();
    expect(catalogCalls(api)).toHaveLength(1);

    const processCount = CATALOG.filter((permission) => permission.module === 'process').length;
    const processList = screen.getByRole('list', {
      name: 'Permissões do módulo Processo',
      hidden: true,
    });
    expect(within(processList).getAllByRole('listitem', { hidden: true })).toHaveLength(
      processCount,
    );
    const processGroup = processList.closest('[data-state]')?.parentElement;
    expect(processGroup?.textContent).toContain(`${String(processCount)} permiss`);
    expect(within(processList).getByText('PROCESS_VIEW')).toBeTruthy();
    // A ordem dos módulos segue a primeira aparição no catálogo.
    const summaries = [...document.querySelectorAll('[data-module-label]')].map(
      (element) => element.textContent,
    );
    expect(summaries[0]).toBe('Processo');
    // axe sobre os 69 itens é lento com a suíte inteira em paralelo (mesma folga do SCR-108).
    expect(await seriousA11yViolations()).toEqual([]);
  }, 20_000);

  it('o selo de risco traz o texto, e "Aceita escopo" aparece só nas permissões com escopo', async () => {
    mockApi();
    renderWithShell(<PermissionCatalogPanel />);
    await screen.findByText('Visualizar processos');

    const high = CATALOG.filter((permission) => permission.riskLevel === 'HIGH').length;
    const low = CATALOG.filter((permission) => permission.riskLevel === 'LOW').length;
    expect(screen.getAllByText('Risco alto', { selector: 'span' })).toHaveLength(high);
    expect(screen.getAllByText('Risco baixo', { selector: 'span' })).toHaveLength(low);
    expect(high).toBeGreaterThan(0);
    expect(screen.getAllByText('Aceita escopo')).toHaveLength(
      CATALOG.filter((permission) => permission.scopable).length,
    );
  });

  it('mostra o selo "Descontinuada" apenas na permissão descontinuada (FA-03)', async () => {
    const deprecated = CATALOG.map((permission) =>
      permission.code === 'PROCESS_VIEW' ? { ...permission, isDeprecated: true } : permission,
    );
    mockApi(() => jsonResponse({ data: deprecated, meta: {} }));
    renderWithShell(<PermissionCatalogPanel />);
    await screen.findByText('Visualizar processos');

    const badges = screen.getAllByText('Descontinuada');
    expect(badges).toHaveLength(1);
    expect(badges[0]?.closest('li')?.textContent).toContain('PROCESS_VIEW');
  });

  it('estado de carregamento acessível enquanto o catálogo não chega', async () => {
    mockApi(() => new Promise<Response>(() => undefined) as unknown as Response);
    renderWithShell(<PermissionCatalogPanel />);
    expect((await screen.findByRole('status')).textContent).toContain(
      'Carregando o catálogo de permissões',
    );
    expect(screen.queryByLabelText('Buscar permissão')).toBeNull();
  });
});

describe('[Validação] busca local no catálogo', () => {
  it('filtra por nome, código e descrição, sem diferenciar acento nem maiúsculas', async () => {
    mockApi();
    renderWithShell(<PermissionCatalogPanel />);
    await screen.findByText('Visualizar processos');
    const search = screen.getByLabelText('Buscar permissão');

    await userEvent.type(search, 'PROCESS_VIEW');
    expect(screen.getAllByRole('listitem', { hidden: true }).length).toBeGreaterThan(0);
    expect(screen.getByText('Visualizar processos')).toBeTruthy();
    expect(screen.queryByText('Criar processo')).toBeNull();

    await userEvent.clear(search);
    await userEvent.type(search, 'visualizar PROCESSOS');
    expect(screen.getByText('Visualizar processos')).toBeTruthy();

    const byDescription = CATALOG.filter((permission) =>
      permission.description
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .includes('custodia'),
    );
    expect(byDescription.length).toBeGreaterThan(0);
    await userEvent.clear(search);
    await userEvent.type(search, 'CUSTÓDIA');
    expect(screen.getAllByRole('listitem', { hidden: true })).toHaveLength(
      CATALOG.filter((permission) =>
        [permission.name, permission.code, permission.description]
          .join(' ')
          .normalize('NFD')
          .replace(/\p{Diacritic}/gu, '')
          .toLowerCase()
          .includes('custodia'),
      ).length,
    );
  }, 15_000);

  it('sem resultado, informa "Nenhuma permissão encontrada"', async () => {
    mockApi();
    renderWithShell(<PermissionCatalogPanel />);
    await screen.findByText('Visualizar processos');
    await userEvent.type(screen.getByLabelText('Buscar permissão'), 'zzzxxx');
    expect(screen.getByText('Nenhuma permissão encontrada')).toBeTruthy();
    expect(screen.queryAllByRole('listitem', { hidden: true })).toHaveLength(0);
  });
});

describe('[Permissão] e falhas de carga', () => {
  it('sem ROLE_VIEW a API responde 403 e a tela mostra o alerta, sem catálogo', async () => {
    mockApi(() => problemResponse(403, 'PERMISSION_DENIED', 'Você não tem permissão.'));
    renderWithShell(<PermissionCatalogPanel />);
    expect(
      await screen.findByText('Você não tem permissão para ver perfis e permissões.'),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Buscar permissão')).toBeNull();
  });

  it('falha de carga (429) oferece "Tentar novamente" e o refetch recupera o catálogo', async () => {
    // 5xx vai ao error.tsx do segmento (shouldThrowToBoundary); a falha tratada na tela é 4xx, como o 429.
    let broken = true;
    const api = mockApi(() =>
      broken
        ? problemResponse(429, 'RATE_LIMITED', 'Muitas tentativas.')
        : jsonResponse({ data: CATALOG, meta: {} }),
    );
    renderWithShell(<PermissionCatalogPanel />);
    const retry = await screen.findByRole(
      'button',
      { name: 'Tentar novamente' },
      { timeout: 5000 },
    );
    expect(screen.getByText('Não foi possível carregar o catálogo de permissões.')).toBeTruthy();
    broken = false;
    const callsBefore = catalogCalls(api).length;
    await userEvent.click(retry);
    expect(await screen.findByText('Visualizar processos')).toBeTruthy();
    await waitFor(() => {
      expect(catalogCalls(api).length).toBeGreaterThan(callsBefore);
    });
  }, 10_000);
});
