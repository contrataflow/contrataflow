// @vitest-environment jsdom
import { Toaster } from '@contrataflow/ui';
import type { NotificationDto } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, problem, renderWithShell, requestUrl } from '@test/support/render';

import { NotificationBell } from './notification-bell';
import { NotificationList } from './notification-list';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

const PROCESS = '0192a000-0000-7000-8000-0000000000f1';
let sequence = 0;

function notification(overrides: Partial<NotificationDto> = {}): NotificationDto {
  sequence += 1;
  return {
    id: `0192a000-0000-7000-8000-${String(sequence).padStart(12, '0')}`,
    type: 'PROCESS_RETURNED',
    priority: 'NORMAL',
    title: `Processo devolvido ${String(sequence)}`,
    body: 'Um processo foi devolvido para ajustes. Abra-o para ver o motivo.',
    link: `/processos/${PROCESS}`,
    processId: PROCESS,
    entityType: 'Process',
    entityId: PROCESS,
    groupKey: `PROCESS_RETURNED:${PROCESS}`,
    groupCount: 1,
    groupedEventIds: [],
    readAt: null,
    archivedAt: null,
    emailStatus: 'PENDING',
    emailSentAt: null,
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    ...overrides,
  };
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

interface Routes {
  readonly count?: Handler;
  readonly list?: Handler;
  readonly read?: Handler;
  readonly readAll?: Handler;
  readonly archive?: Handler;
}

function mockApi(routes: Routes = {}) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    const pick = (handler: Handler | undefined, fallback: () => Response) =>
      Promise.resolve((handler ?? fallback)(url, init));
    if (method === 'GET' && url.startsWith('/api/v1/notifications/unread-count')) {
      return pick(routes.count, () => jsonResponse({ data: { count: 0 } }));
    }
    if (method === 'GET' && url.startsWith('/api/v1/notifications')) {
      return pick(routes.list, () =>
        jsonResponse({ data: [], meta: { nextCursor: null, hasMore: false } }),
      );
    }
    if (method === 'POST' && url === '/api/v1/notifications/read-all') {
      return pick(routes.readAll, () => jsonResponse({ data: { updated: 0 } }));
    }
    if (method === 'POST' && url.endsWith('/read')) {
      return pick(routes.read, () => problem(500, 'INTERNAL_ERROR'));
    }
    if (method === 'POST' && url.endsWith('/archive')) {
      return pick(routes.archive, () => problem(500, 'INTERNAL_ERROR'));
    }
    return Promise.resolve(problem(404, 'NOT_FOUND'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const calls = (api: ReturnType<typeof mockApi>, method: string, prefix: string) =>
  api.mock.calls
    .filter(([, init]) => (init?.method ?? 'GET') === method)
    .map(([input]) => requestUrl(input))
    .filter((url) => url.startsWith(prefix));

/** Elemento na posição (falha clara se faltar). */
function nth(elements: readonly HTMLElement[], index: number): HTMLElement {
  const element = elements[index];
  if (!element) throw new Error(`sem elemento ${String(index)}`);
  return element;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NotificationBell (SCR-036 · sininho global)', () => {
  it('[Sucesso] mostra o contador, anuncia via aria-live e abre o painel com as recentes', async () => {
    const recente = notification({ title: 'Processo devolvido para você' });
    const lida = notification({
      title: 'Aprovação concluída',
      type: 'APPROVAL_DECIDED',
      readAt: new Date().toISOString(),
    });
    const api = mockApi({
      count: () => jsonResponse({ data: { count: 3 } }),
      list: () =>
        jsonResponse({ data: [recente, lida], meta: { nextCursor: null, hasMore: false } }),
    });
    renderWithShell(<NotificationBell />);

    const bells = await screen.findAllByRole('button', { name: 'Notificações (3 não lidas)' });
    expect(bells).toHaveLength(1);
    // Abaixo de 768 px o sininho é um link direto para a página cheia.
    expect(
      screen.getByRole('link', { name: 'Notificações (3 não lidas)' }).getAttribute('href'),
    ).toBe('/notificacoes');
    const live = screen.getByText('3 notificações não lidas');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(await seriousA11yViolations()).toEqual([]);

    await userEvent.click(nth(bells, 0));
    // Popover (prd-5) com as 5 mais recentes; a não lida é anunciada como tal.
    const panel = await screen.findByRole('dialog', { name: 'Notificações recentes' });
    const unread = await within(panel).findByRole('link', { name: /Processo devolvido para você/ });
    expect(unread.textContent).toContain('(Não lida)');
    expect(within(panel).getByRole('link', { name: /Aprovação concluída/ })).toBeTruthy();
    expect(
      within(panel).getByRole('link', { name: 'Ver todas as notificações' }).getAttribute('href'),
    ).toBe('/notificacoes');
    // US-113: atalho para a aba de preferências do perfil.
    expect(
      within(panel).getByRole('link', { name: 'Gerenciar preferências' }).getAttribute('href'),
    ).toBe('/perfil?aba=notificacoes');
    expect(within(panel).getByRole('button', { name: 'Marcar todas como lidas' })).toBeTruthy();
    expect(calls(api, 'GET', '/api/v1/notifications?')).toEqual(['/api/v1/notifications?limit=5']);
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('sem não lidas: rótulo simples, sem selo; resposta fora do formato conta como zero', async () => {
    mockApi({ count: () => jsonResponse({ data: { permissions: [] } }) });
    renderWithShell(<NotificationBell />);
    expect(await screen.findByRole('button', { name: 'Notificações' })).toBeTruthy();
    expect(screen.getByText('Nenhuma notificação não lida')).toBeTruthy();
  });

  it('[Falha de integração] API fora: o sininho mantém o último contador conhecido', async () => {
    let up = true;
    mockApi({
      count: () =>
        up ? jsonResponse({ data: { count: 2 } }) : problem(503, 'DEPENDENCY_UNAVAILABLE'),
    });
    const { queryClient } = renderWithShell(<NotificationBell />);
    expect(await screen.findByRole('button', { name: 'Notificações (2 não lidas)' })).toBeTruthy();
    up = false;
    await queryClient.refetchQueries();
    expect(screen.getByRole('button', { name: 'Notificações (2 não lidas)' })).toBeTruthy();
  });

  it('painel vazio: "Nenhuma notificação por aqui ainda" (FA-04)', async () => {
    mockApi();
    renderWithShell(<NotificationBell />);
    await userEvent.click(await screen.findByRole('button', { name: 'Notificações' }));
    expect(await screen.findByText('Nenhuma notificação por aqui ainda')).toBeTruthy();
  });
});

describe('NotificationList (SCR-036 · /notificacoes)', () => {
  it('[Sucesso] lista com estado lido/não lido, agrupamento e sem violações de a11y', async () => {
    const naoLida = notification({ title: 'Processo devolvido' });
    const agrupada = notification({
      title: 'Nova resposta ao seu comentário',
      type: 'COMMENT_REPLY',
      groupCount: 3,
      readAt: new Date().toISOString(),
    });
    mockApi({
      list: () =>
        jsonResponse({ data: [naoLida, agrupada], meta: { nextCursor: null, hasMore: false } }),
    });
    renderWithShell(<NotificationList />);
    expect(screen.getByRole('status').textContent).toContain('Carregando notificações…');
    const list = await screen.findByRole('list', { name: 'Notificações' });
    // Agrupada por dia: as duas são de hoje, num grupo só.
    expect(within(list).getByRole('heading', { name: 'Hoje' })).toBeTruthy();
    const items = within(list)
      .getAllByRole('listitem')
      .filter((item) => item.parentElement !== list);
    expect(items).toHaveLength(2);
    expect(within(nth(items, 0)).getByText('Não lida')).toBeTruthy();
    expect(
      within(nth(items, 0)).getByRole('link', { name: 'Processo devolvido' }).getAttribute('href'),
    ).toBe(`/processos/${PROCESS}`);
    expect(within(nth(items, 1)).getByText('Lida')).toBeTruthy();
    expect(within(nth(items, 1)).getByText('3 avisos agrupados')).toBeTruthy();
    // Item lido não oferece "Marcar como lida".
    expect(within(nth(items, 1)).queryByRole('button', { name: /Marcar como lida/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Preferências de notificação' })).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('pagina por cursor ("Carregar mais") e filtra "Não lidas" (unreadOnly=true)', async () => {
    const first = notification({ title: 'Primeira' });
    const second = notification({ title: 'Segunda' });
    const api = mockApi({
      list: (url) =>
        url.includes('cursor=c1')
          ? jsonResponse({ data: [second], meta: { nextCursor: null, hasMore: false } })
          : jsonResponse({ data: [first], meta: { nextCursor: 'c1', hasMore: true } }),
    });
    renderWithShell(<NotificationList />);
    await screen.findByRole('link', { name: 'Primeira' });
    await userEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    await screen.findByRole('link', { name: 'Segunda' });
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();

    await userEvent.click(screen.getByRole('tab', { name: 'Não lidas' }));
    await waitFor(() => {
      expect(calls(api, 'GET', '/api/v1/notifications?')).toContain(
        '/api/v1/notifications?limit=20&unreadOnly=true',
      );
    });
    expect(screen.getByRole('tab', { name: 'Não lidas' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('marcar como lida (NTF-03), arquivar (NTF-05) e marcar todas (NTF-04) recarregam a lista', async () => {
    const item = notification({ title: 'Aprovação pendente', type: 'APPROVAL_REQUESTED' });
    const api = mockApi({
      list: () => jsonResponse({ data: [item], meta: { nextCursor: null, hasMore: false } }),
      read: () => jsonResponse({ data: { ...item, readAt: new Date().toISOString() } }),
      archive: () => jsonResponse({ data: { ...item, archivedAt: new Date().toISOString() } }),
      readAll: () => jsonResponse({ data: { updated: 1 } }),
    });
    renderWithShell(
      <>
        <NotificationList />
        <Toaster label="Avisos" closeLabel="Fechar" />
      </>,
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'Marcar como lida: Aprovação pendente' }),
    );
    await waitFor(() => {
      expect(calls(api, 'POST', '/api/v1/notifications/')).toEqual([
        `/api/v1/notifications/${item.id}/read`,
      ]);
    });
    await userEvent.click(screen.getByRole('button', { name: 'Arquivar: Aprovação pendente' }));
    expect(await screen.findByText('Notificação arquivada.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Marcar todas como lidas' }));
    expect(await screen.findByText('1 notificação marcada como lida')).toBeTruthy();
    expect(calls(api, 'POST', '/api/v1/notifications/')).toEqual([
      `/api/v1/notifications/${item.id}/read`,
      `/api/v1/notifications/${item.id}/archive`,
      '/api/v1/notifications/read-all',
    ]);
    // Cada mutação relê a lista.
    expect(calls(api, 'GET', '/api/v1/notifications?').length).toBeGreaterThanOrEqual(4);
  });

  it('[Permissão] notificação que não existe mais (404) avisa e relê a lista', async () => {
    const item = notification({ title: 'Processo recebido', type: 'PROCESS_RECEIVED' });
    let gone = false;
    mockApi({
      list: () =>
        jsonResponse({ data: gone ? [] : [item], meta: { nextCursor: null, hasMore: false } }),
      read: () => {
        gone = true;
        return problem(404, 'NOTIFICATION_NOT_FOUND');
      },
    });
    renderWithShell(
      <>
        <NotificationList />
        <Toaster label="Avisos" closeLabel="Fechar" />
      </>,
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'Marcar como lida: Processo recebido' }),
    );
    expect(await screen.findByText('Esta notificação não está mais disponível.')).toBeTruthy();
    expect(await screen.findByText('Nenhuma notificação por aqui ainda')).toBeTruthy();
  });

  it('abrir o link marca a notificação não lida como lida', async () => {
    const item = notification({ title: 'Você foi mencionado', type: 'MENTIONED' });
    const api = mockApi({
      list: () => jsonResponse({ data: [item], meta: { nextCursor: null, hasMore: false } }),
      read: () => jsonResponse({ data: { ...item, readAt: new Date().toISOString() } }),
    });
    renderWithShell(<NotificationList />);
    const link = await screen.findByRole('link', { name: 'Você foi mencionado' });
    link.addEventListener('click', (event) => {
      event.preventDefault();
    });
    await userEvent.click(link);
    await waitFor(() => {
      expect(calls(api, 'POST', '/api/v1/notifications/')).toEqual([
        `/api/v1/notifications/${item.id}/read`,
      ]);
    });
  });

  it('[FA-04] vazio e [Validação/erro] falha de carga com "Tentar novamente"', async () => {
    let fail = true;
    mockApi({
      list: () =>
        fail
          ? problem(422, 'VALIDATION_ERROR')
          : jsonResponse({ data: [], meta: { nextCursor: null, hasMore: false } }),
    });
    renderWithShell(<NotificationList />);
    expect(await screen.findByText('Não foi possível carregar as notificações.')).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('Nenhuma notificação por aqui ainda')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Marcar todas como lidas' }).hasAttribute('disabled'),
    ).toBe(true);
  });
});
