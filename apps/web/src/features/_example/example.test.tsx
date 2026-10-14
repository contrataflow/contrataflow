// @vitest-environment jsdom
import { HydrationBoundary, dehydrate } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeServerQueryClient } from '@/lib/query/query-client';
import { seriousA11yViolations } from '@test/support/axe';
import { TENANT_A, jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { ExampleView } from './example-view';
import { exampleKeys } from './example.api';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => '/exemplo',
}));

const PING = {
  data: {
    status: 'ok',
    correlationId: 'c-server-1',
    tenantId: TENANT_A.id,
    userId: 'u',
    membershipId: 'm',
  },
  status: 200,
  meta: { etag: null, correlationId: 'c-server-1', replayed: false },
};
const ITEMS = {
  data: [
    { id: 'item-01', position: 1 },
    { id: 'item-02', position: 2 },
  ],
  status: 200,
  meta: {
    page: 1,
    pageSize: 10,
    totalItems: 45,
    totalPages: 5,
    etag: null,
    correlationId: 'c',
    replayed: false,
  },
};

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

function mockApi(routes: Record<string, Route>) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!route) return Promise.resolve(jsonResponse({ code: 'NOT_FOUND' }, { status: 404 }));
    return Promise.resolve(route[1](url, init));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const ALLOWED = () =>
  jsonResponse({ data: { permissions: [{ code: 'PROCESS_CREATE', scopes: ['TENANT'] }] } });
const NONE = () =>
  jsonResponse({ data: { permissions: [{ code: 'PROCESS_VIEW', scopes: ['TENANT'] }] } });

function prefetched() {
  const server = makeServerQueryClient();
  server.setQueryData(exampleKeys.ping(TENANT_A.id), PING);
  server.setQueryData(exampleKeys.items(TENANT_A.id, 1), ITEMS);
  return dehydrate(server);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[Sucesso] página de exemplo com prefetch no servidor', () => {
  it('consome os dados hidratados sem nova chamada à API', async () => {
    const api = mockApi({ '/api/v1/me/permissions': ALLOWED });
    renderWithShell(
      <HydrationBoundary state={prefetched()}>
        <ExampleView />
      </HydrationBoundary>,
    );
    expect(screen.getByText('c-server-1')).toBeTruthy();
    expect(screen.getByText('item-01')).toBeTruthy();
    expect(screen.getByText('45 itens · página 1 de 5')).toBeTruthy();
    expect(screen.getByText(/^Valor de referência: R\$\s1\.234\.567,89$/)).toBeTruthy();
    await screen.findByRole('button', { name: 'Criar registro' });
    const called = api.mock.calls.map(([url]) => requestUrl(url));
    expect(called).toEqual(['/api/v1/me/permissions']);
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('paginação busca a próxima página pela API', async () => {
    const api = mockApi({
      '/api/v1/me/permissions': NONE,
      '/api/v1/_internal/items': () =>
        jsonResponse({ data: [{ id: 'item-11', position: 11 }], meta: ITEMS.meta }),
    });
    renderWithShell(
      <HydrationBoundary state={prefetched()}>
        <ExampleView />
      </HydrationBoundary>,
    );
    await userEvent.click(screen.getByRole('button', { name: /Próxima página/ }));
    await screen.findByText('item-11');
    expect(
      api.mock.calls.some(
        ([url]) => requestUrl(url) === '/api/v1/_internal/items?page=2&pageSize=10',
      ),
    ).toBe(true);
  });
});

describe('[Permissão] botão protegido por <Can>', () => {
  it('Carlos sem PROCESS_CREATE não vê o formulário nem o botão', async () => {
    const api = mockApi({ '/api/v1/me/permissions': NONE });
    renderWithShell(
      <HydrationBoundary state={prefetched()}>
        <ExampleView />
      </HydrationBoundary>,
    );
    await waitFor(() => {
      expect(api).toHaveBeenCalled();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('button', { name: 'Criar registro' })).toBeNull();
    expect(screen.queryByLabelText('Nome')).toBeNull();
  });
});

describe('[Validação] formulário de exemplo com os schemas compartilhados', () => {
  it('campo obrigatório vazio mostra erro em pt-BR e não chama a API', async () => {
    const api = mockApi({ '/api/v1/me/permissions': ALLOWED });
    renderWithShell(
      <HydrationBoundary state={prefetched()}>
        <ExampleView />
      </HydrationBoundary>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Criar registro' }));
    const message = await screen.findByText('Campo obrigatório.');
    const input = screen.getByLabelText('Nome');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(message.id);
    await userEvent.type(screen.getByLabelText('Quantidade (opcional)'), '0');
    await userEvent.type(input, 'Item');
    await userEvent.click(screen.getByRole('button', { name: 'Criar registro' }));
    expect(
      await screen.findByText('Pequeno demais: esperava que o número fosse >= 1'),
    ).toBeTruthy();
    expect(
      api.mock.calls.filter(([url]) => requestUrl(url).includes('/_internal/echo')),
    ).toHaveLength(0);
  });

  it('errors[] do servidor voltam para o campo', async () => {
    mockApi({
      '/api/v1/me/permissions': ALLOWED,
      '/api/v1/_internal/echo': () =>
        jsonResponse(
          {
            type: 'https://docs.contrataflow.com.br/errors/validation-error',
            title: 'Erro',
            status: 422,
            detail: 'Dados inválidos.',
            instance: '/api/v1/_internal/echo',
            code: 'VALIDATION_ERROR',
            correlationId: 'c-422',
            errors: [{ field: 'name', code: 'TOO_LONG', message: 'Nome já usado no servidor.' }],
            violations: [],
          },
          { status: 422 },
        ),
    });
    renderWithShell(
      <HydrationBoundary state={prefetched()}>
        <ExampleView />
      </HydrationBoundary>,
    );
    await userEvent.type(await screen.findByLabelText('Nome'), 'Repetido');
    await userEvent.click(screen.getByRole('button', { name: 'Criar registro' }));
    expect(await screen.findByText('Nome já usado no servidor.')).toBeTruthy();
  });
});

describe('[Duplicidade] clique duplo reaproveita a Idempotency-Key', () => {
  it('duas chamadas com a mesma chave e o mesmo resultado', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const echo = {
      data: { id: '0192a000-0000-7000-8000-0000000000e1', name: 'Item', quantity: null },
    };
    const api = mockApi({
      '/api/v1/me/permissions': ALLOWED,
      '/api/v1/_internal/echo': async () => {
        await gate;
        return jsonResponse(echo, { status: 201 });
      },
    });
    renderWithShell(
      <HydrationBoundary state={prefetched()}>
        <ExampleView />
      </HydrationBoundary>,
    );
    await userEvent.type(await screen.findByLabelText('Nome'), 'Item');
    const button = screen.getByRole('button', { name: 'Criar registro' });
    await userEvent.dblClick(button);
    await waitFor(() => {
      expect(
        api.mock.calls.filter(([url]) => requestUrl(url).includes('/_internal/echo')),
      ).toHaveLength(2);
    });
    release();
    const calls = api.mock.calls.filter(([url]) => requestUrl(url).includes('/_internal/echo'));
    const keys = calls.map(([, init]) => new Headers(init?.headers).get('Idempotency-Key'));
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Nome').value).toBe('');
    });

    // Nova intenção → nova chave.
    await userEvent.type(screen.getByLabelText('Nome'), 'Outro');
    await userEvent.click(screen.getByRole('button', { name: 'Criar registro' }));
    await waitFor(() => {
      expect(
        api.mock.calls.filter(([url]) => requestUrl(url).includes('/_internal/echo')),
      ).toHaveLength(3);
    });
    const third = api.mock.calls.filter(([url]) => requestUrl(url).includes('/_internal/echo'))[2];
    expect(new Headers(third?.[1]?.headers).get('Idempotency-Key')).not.toBe(keys[0]);
  });
});
