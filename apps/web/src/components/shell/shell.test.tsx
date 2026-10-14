// @vitest-environment jsdom
import { QueryClient } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Can, resolveCanState } from '@/lib/permissions/can';
import { tenantKey } from '@/lib/query/keys';
import { publishSessionEvent } from '@/lib/session/session-channel';
import { SessionSync } from '@/lib/session/session-sync';
import { seriousA11yViolations } from '@test/support/axe';
import {
  IntlProvider,
  TENANT_A,
  TENANT_B,
  jsonResponse,
  renderWithShell,
  requestUrl,
  shellSession,
} from '@test/support/render';

import { AppProviders } from './app-providers';
import { AppShell } from './app-shell';
import { AdminNav } from './main-nav';
import { isActivePath } from './navigation';

const router = { refresh: vi.fn() };
let pathname = '/exemplo';

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => pathname,
}));

beforeEach(() => {
  router.refresh.mockClear();
  pathname = '/exemplo';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const fetchMock = vi.fn<typeof fetch>((input, init) =>
    Promise.resolve(handler(requestUrl(input), init)),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('[Sucesso] AppShell', () => {
  it('renderiza menu, busca, notificações, seletor de instituição e usuário — sem violação de a11y', async () => {
    stubFetch(() => jsonResponse({ data: { permissions: [] } }));
    const session = shellSession();
    render(
      <IntlProvider>
        <AppProviders session={session}>
          <AppShell session={session}>
            <h1>Conteúdo</h1>
          </AppShell>
        </AppProviders>
      </IntlProvider>,
    );
    expect(screen.getByRole('link', { name: 'Pular para o conteúdo' }).getAttribute('href')).toBe(
      '#conteudo',
    );
    const nav = screen.getByRole('navigation', { name: 'Menu principal' });
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe('Exemplo do shell');
    expect(screen.getByRole('search')).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Buscar processos' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Notificações' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Instituição ativa: Prefeitura A' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Menu do usuário Ana Souza' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Abrir menu' })).toBeTruthy();
    expect(screen.getByRole('main').id).toBe('conteudo');
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('tema do tenant só com cor de contraste válido; faixa de somente leitura', () => {
    const session = shellSession({ activeTenant: TENANT_B, readOnly: true });
    const { container } = renderWithShell(<AppShell session={session}>x</AppShell>, { session });
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.getPropertyValue('--color-primary')).toBe('#0f766e');
    expect(
      screen.getByText('Instituição em encerramento: somente consulta e exportação.'),
    ).toBeTruthy();
    const plain = renderWithShell(<AppShell session={shellSession()}>y</AppShell>);
    expect(
      (plain.container.firstElementChild as HTMLElement).style.getPropertyValue('--color-primary'),
    ).toBe('');
  });

  it('gaveta do menu móvel abre com foco preso e fecha ao navegar', async () => {
    renderWithShell(<AppShell session={shellSession()}>x</AppShell>);
    await userEvent.click(screen.getByRole('button', { name: 'Abrir menu' }));
    const dialog = await screen.findByRole('dialog', { name: 'ContrataFlow' });
    expect(dialog.querySelector('nav')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('link', { name: 'Processos' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('navegação de administração marca a área atual', () => {
    pathname = '/admin/usuarios/123';
    renderWithShell(<AdminNav />);
    const nav = screen.getByRole('navigation', { name: 'Navegação de administração' });
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe('Usuários');
    expect(isActivePath('/processosx', '/processos')).toBe(false);
  });
});

describe('[Tenant incorreto] seletor de instituição', () => {
  it('troca para a Prefeitura B limpando o cache antes do refresh', async () => {
    const fetchMock = stubFetch((url) =>
      url === '/api/auth/switch-tenant'
        ? jsonResponse({ data: shellSession({ activeTenant: TENANT_B }) })
        : jsonResponse({ data: { permissions: [] } }),
    );
    const queryClient = new QueryClient();
    queryClient.setQueryData(tenantKey(TENANT_A.id, 'processes'), ['dado da Prefeitura A']);
    renderWithShell(<AppShell session={shellSession()}>x</AppShell>, { queryClient });
    await userEvent.click(screen.getByRole('button', { name: 'Instituição ativa: Prefeitura A' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Prefeitura B' }));
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/auth/switch-tenant')).toBe(true);
    expect(queryClient.getQueryData(tenantKey(TENANT_A.id, 'processes'))).toBeUndefined();
  });

  it('escolher a instituição atual não faz nada; falha avisa sem limpar', async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ code: 'MEMBERSHIP_INACTIVE' }, { status: 403 }),
    );
    const queryClient = new QueryClient();
    queryClient.setQueryData(tenantKey(TENANT_A.id, 'x'), 1);
    renderWithShell(<AppShell session={shellSession()}>x</AppShell>, { queryClient });
    await userEvent.click(screen.getByRole('button', { name: 'Instituição ativa: Prefeitura A' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Prefeitura A/ }));
    expect(fetchMock).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Instituição ativa: Prefeitura A' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Prefeitura B' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(queryClient.getQueryData(tenantKey(TENANT_A.id, 'x'))).toBe(1);
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe('[Concorrência] duas abas com tenants diferentes', () => {
  it('a outra aba é notificada, limpa o cache e recarrega ao voltar o foco', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(tenantKey(TENANT_A.id, 'processes'), ['dado da Prefeitura A']);
    const fetchMock = stubFetch(() =>
      jsonResponse({ data: { activeTenant: { id: TENANT_B.id } } }),
    );
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    renderWithShell(<SessionSync onNavigate={vi.fn()} />, { queryClient });

    publishSessionEvent({ type: 'tenant-switched', tenantId: TENANT_B.id });
    await waitFor(() => {
      expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    });
    expect(router.refresh).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/auth/session?keepalive=1');
  });

  it('aba visível recarrega na hora; mensagem do próprio tenant é ignorada', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(tenantKey(TENANT_A.id, 'x'), 1);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    renderWithShell(<SessionSync onNavigate={vi.fn()} />, { queryClient });
    publishSessionEvent({ type: 'tenant-switched', tenantId: TENANT_A.id });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(queryClient.getQueryData(tenantKey(TENANT_A.id, 'x'))).toBe(1);
    publishSessionEvent({ type: 'tenant-switched', tenantId: TENANT_B.id });
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalledTimes(1);
    });
  });

  it('logout/expiração em outra aba levam ao login; foco sem sessão também', async () => {
    const navigate = vi.fn();
    stubFetch(() => jsonResponse({}, { status: 401 }));
    renderWithShell(<SessionSync onNavigate={navigate} />);
    publishSessionEvent({ type: 'logout' });
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('/entrar?motivo=saiu');
    });
    publishSessionEvent({ type: 'expired' });
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('/entrar?motivo=sessao-expirada');
    });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('/api/auth/login?returnTo=%2F');
    });
  });
});

describe('[Permissão] <Can> oculta × desabilita', () => {
  it('regra pura', () => {
    expect(resolveCanState({ allowed: false })).toEqual({ kind: 'hidden' });
    expect(resolveCanState({ allowed: true })).toEqual({ kind: 'enabled' });
    expect(
      resolveCanState({ allowed: true, action: 'forward', allowedActions: ['forward'] }),
    ).toEqual({
      kind: 'enabled',
    });
    expect(resolveCanState({ allowed: true, action: 'forward', allowedActions: [] })).toEqual({
      kind: 'disabled',
      reason: 'Ação indisponível no momento.',
    });
    expect(
      resolveCanState({
        allowed: false,
        action: 'forward',
        allowedActions: [],
        unavailableReason: 'x',
      }),
    ).toEqual({ kind: 'hidden' });
  });

  it.each([
    ['sem a permissão em nenhum escopo → oculto', [], undefined, 'hidden'],
    ['com a permissão → habilitado', ['PROCESS_CREATE'], undefined, 'enabled'],
    [
      'com a permissão, indisponível no contexto → desabilitado com motivo',
      ['PROCESS_CREATE'],
      [],
      'disabled',
    ],
  ] as const)('%s', async (_name, codes, allowedActions, expected) => {
    stubFetch(() =>
      jsonResponse({ data: { permissions: codes.map((code) => ({ code, scopes: ['TENANT'] })) } }),
    );
    renderWithShell(
      <>
        <Can
          permission="PROCESS_CREATE"
          action="create"
          allowedActions={allowedActions}
          unavailableReason="Unidade sem titular."
        >
          <button type="button">Criar</button>
        </Can>
        <Can permission="PROCESS_CREATE" action="create" allowedActions={allowedActions}>
          {({ disabled, describedBy }) => (
            <button type="button" disabled={disabled} aria-describedby={describedBy}>
              Render-prop
            </button>
          )}
        </Can>
      </>,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const button = screen.queryByRole('button', { name: 'Criar' });
    if (expected === 'hidden') {
      expect(button).toBeNull();
      expect(screen.queryByRole('button', { name: 'Render-prop' })).toBeNull();
      return;
    }
    await screen.findByRole('button', { name: 'Criar' });
    const renderProp = screen.getByRole<HTMLButtonElement>('button', { name: 'Render-prop' });
    if (expected === 'enabled') {
      expect(renderProp.disabled).toBe(false);
      return;
    }
    expect(screen.getByRole('group').hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Unidade sem titular.')).toBeTruthy();
    expect(renderProp.disabled).toBe(true);
    expect(
      document.getElementById(renderProp.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe('Ação indisponível no momento.');
  });

  it('erro ao ler permissões só oculta (a API continua decidindo)', async () => {
    stubFetch(() => jsonResponse({ code: 'INTERNAL_ERROR' }, { status: 500 }));
    renderWithShell(
      <Can permission="PROCESS_CREATE">
        <button type="button">Criar</button>
      </Can>,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole('button', { name: 'Criar' })).toBeNull();
  });
});
