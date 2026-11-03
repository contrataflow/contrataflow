// @vitest-environment jsdom
import { Toaster } from '@contrataflow/ui';
import { QueryClient } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LogoutGuard } from '@/components/session/logout-guard';
import { LocalDrafts, MemoryDraftBackend } from '@/lib/drafts/local-drafts';
import { Can, resolveCanState } from '@/lib/permissions/can';
import { tenantKey } from '@/lib/query/keys';
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
import { postFromOtherTab } from '@test/support/session-tabs';

import { AppProviders } from './app-providers';
import { AppShell } from './app-shell';
import { MainNav } from './main-nav';
import { isActivePath } from './navigation';
import { UserCard } from './user-card';

const router = { refresh: vi.fn(), push: vi.fn() };
let pathname = '/exemplo';

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => pathname,
}));

beforeEach(() => {
  router.refresh.mockClear();
  router.push.mockClear();
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
  it('esconde o item da página de exemplo fora de local/dev/test', () => {
    vi.stubEnv('APP_ENV', 'production');
    try {
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
      const nav = screen.getByRole('navigation', { name: 'Menu principal' });
      expect(within(nav).queryByRole('link', { name: 'Exemplo do shell' })).toBeNull();
      expect(within(nav).getByRole('link', { name: 'Processos' })).toBeTruthy();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('renderiza menu, busca, ajuda, notificações, instituição e cartão do usuário — sem violação de a11y', async () => {
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
    const search = screen.getByRole('button', { name: 'Busca global' });
    expect(search.getAttribute('aria-haspopup')).toBe('dialog');
    expect(search.getAttribute('aria-keyshortcuts')).toBe('Control+K');
    expect(screen.getByRole('link', { name: 'Notificações' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Ajuda' }).getAttribute('href')).toBe(
      'mailto:suporte@contrataflow.com.br',
    );
    // Instituição como texto (nome + "Instituição ativa · trocar") que abre o seletor.
    const tenant = screen.getByRole('button', { name: 'Instituição ativa: Prefeitura A' });
    expect(tenant.textContent).toBe('Prefeitura AInstituição ativa · trocar');
    // Barra superior limpa (prd-6 · §2.2): sem "Novo processo" e sem menu do usuário.
    const header = screen.getByRole('banner');
    expect(within(header).queryByRole('link', { name: 'Novo processo' })).toBeNull();
    expect(within(header).queryByRole('button', { name: /Menu do usuário/ })).toBeNull();
    // Cartão do usuário no rodapé da barra lateral.
    expect(screen.getByText('Ana Souza')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Minha conta' }).getAttribute('href')).toBe('/perfil');
    expect(screen.getByRole('button', { name: 'Sair' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Abrir menu' })).toBeTruthy();
    expect(screen.getByRole('main').id).toBe('conteudo');
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('itens principais sem rótulo de grupo; "Sistema" com Auditoria e Administração aberta em /admin', () => {
    pathname = '/admin/usuarios';
    renderWithShell(<AppShell session={shellSession()}>x</AppShell>);
    const nav = screen.getByRole('navigation', { name: 'Menu principal' });
    expect(within(nav).queryByText('Operação')).toBeNull();
    expect(within(nav).queryByText('Governança')).toBeNull();
    const [main] = within(nav).getAllByRole('list');
    const system = within(nav).getByRole('list', { name: 'Sistema' });
    expect(
      Array.from(main?.querySelectorAll(':scope > li > a') ?? []).map((link) => link.textContent),
    ).toEqual([
      'Painel',
      'Caixa de tarefas',
      'Aprovações',
      'Processos',
      'Fornecedores',
      'Exemplo do shell',
    ]);
    expect(
      within(system)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([
      'Auditoria',
      'Administração',
      'Usuários',
      'Perfis e permissões',
      'Estrutura organizacional',
      'Templates',
      'Workflows',
      'Tipos de documento',
      'Catálogos',
      'Calendário',
      'Configurações',
    ]);
    // A área atual leva o `aria-current`; o item do grupo só o leva no hub.
    const areas = within(system).getByRole('list', { name: 'Áreas de administração' });
    expect(within(areas).getByRole('link', { name: 'Usuários' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(
      within(system).getByRole('link', { name: 'Administração' }).getAttribute('aria-current'),
    ).toBeNull();
    // O antigo "Precisa de ajuda?" do rodapé vira o ícone de ajuda da barra superior.
    expect(screen.queryByText('Precisa de ajuda?')).toBeNull();
  });

  it('Administração recolhível: fechada fora de /admin, abre e fecha pelo chevron', async () => {
    pathname = '/processos';
    renderWithShell(<MainNav />);
    const toggle = screen.getByRole('button', { name: 'Áreas de administração' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('link', { name: 'Usuários' })).toBeNull();
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('link', { name: 'Usuários' }).getAttribute('href')).toBe(
      '/admin/usuarios',
    );
    await userEvent.click(toggle);
    expect(screen.queryByRole('link', { name: 'Usuários' })).toBeNull();
  });

  it('no hub (/admin) o item Administração é a página atual e o grupo começa aberto', () => {
    pathname = '/admin';
    renderWithShell(<MainNav />);
    expect(screen.getByRole('link', { name: 'Administração' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(
      screen.getByRole('button', { name: 'Áreas de administração' }).getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('Ctrl K (e ⌘ K) abre a paleta de comandos de qualquer ponto; outras teclas não', async () => {
    stubFetch(() => jsonResponse({ data: { permissions: [] } }));
    renderWithShell(<AppShell session={shellSession()}>x</AppShell>);
    await userEvent.keyboard('{Control>}{Shift>}k{/Shift}{/Control}');
    expect(screen.queryByRole('dialog', { name: 'Paleta de comandos' })).toBeNull();
    await userEvent.keyboard('{Control>}k{/Control}');
    const palette = await screen.findByRole('dialog', { name: 'Paleta de comandos' });
    expect(document.activeElement).toBe(palette.querySelector('input'));
    expect(document.activeElement?.getAttribute('placeholder')).toBe('Buscar processo ou ir para…');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Paleta de comandos' })).toBeNull();
    });
    await userEvent.keyboard('{Meta>}K{/Meta}');
    expect(await screen.findByRole('dialog', { name: 'Paleta de comandos' })).toBeTruthy();
  });

  it('paleta: "Ir para" filtra as áreas sem acento e navega com Enter', async () => {
    stubFetch(() => jsonResponse({ data: { permissions: [] } }));
    renderWithShell(<AppShell session={shellSession()}>x</AppShell>);
    await userEvent.click(screen.getByRole('button', { name: 'Busca global' }));
    const palette = await screen.findByRole('dialog', { name: 'Paleta de comandos' });
    expect(within(palette).getByRole('option', { name: 'Processos' })).toBeTruthy();
    await userEvent.keyboard('aprovacoes');
    expect(within(palette).queryByRole('option', { name: 'Processos' })).toBeNull();
    // Com a busca, a paleta também oferece "Ver todos os processos com…" (primeiro item).
    await userEvent.click(within(palette).getByRole('option', { name: 'Aprovações' }));
    expect(router.push).toHaveBeenCalledWith('/aprovacoes');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Paleta de comandos' })).toBeNull();
    });
  });

  it('paleta: busca processos pela API da lista (PRC-01 com q) e abre o escolhido', async () => {
    const fetchMock = stubFetch((url) =>
      url.includes('/processes?')
        ? jsonResponse({
            data: [
              {
                id: '0b9d2d4e-2f47-4d5c-9a51-6d1a7b9c0e11',
                code: '0002/2026',
                title: 'Manutenção predial',
              },
            ],
            meta: { page: 1, pageSize: 5, totalItems: 1, totalPages: 1 },
          })
        : jsonResponse({ data: { permissions: [] } }),
    );
    renderWithShell(<AppShell session={shellSession()}>x</AppShell>);
    await userEvent.keyboard('{Control>}k{/Control}');
    const palette = await screen.findByRole('dialog', { name: 'Paleta de comandos' });
    await userEvent.keyboard('manut');
    const option = await within(palette).findByRole('option', { name: /Manutenção predial/ });
    const call = fetchMock.mock.calls
      .map(([input]) => requestUrl(input))
      .find((url) => url.includes('/processes?'));
    expect(call).toContain('q=manut');
    expect(call).toContain('pageSize=5');
    expect(
      within(palette).getByRole('option', { name: 'Ver todos os processos com “manut”' }),
    ).toBeTruthy();
    await userEvent.click(option);
    expect(router.push).toHaveBeenCalledWith('/processos/0b9d2d4e-2f47-4d5c-9a51-6d1a7b9c0e11');
  });

  it('contadores da caixa de tarefas e das aprovações vêm de TSK-02 com INBOX_VIEW', async () => {
    const fetchMock = stubFetch((url) =>
      url.endsWith('/tasks/counters')
        ? jsonResponse({
            data: { mine: 7, pendingApprovals: 120, returned: 0, overdue: 1, following: 0 },
          })
        : jsonResponse({ data: { permissions: [{ code: 'INBOX_VIEW', scopes: ['TENANT'] }] } }),
    );
    renderWithShell(<AppShell session={shellSession()}>x</AppShell>);
    const nav = screen.getByRole('navigation', { name: 'Menu principal' });
    expect(
      await within(nav).findByRole('link', { name: 'Caixa de tarefas (7 pendentes)' }),
    ).toBeTruthy();
    const approvals = within(nav).getByRole('link', { name: 'Aprovações (120 pendentes)' });
    // Contador no texto do item (prd-6 · §2.2), escondido do leitor (que ouve o plural).
    const visible = within(approvals).getByText('· 99+', { normalizer: (text) => text.trim() });
    expect(visible.getAttribute('aria-hidden')).toBe('true');
    expect(within(nav).getByRole('link', { name: /^Caixa de tarefas/ }).textContent).toContain(
      'Caixa de tarefas · 7',
    );
    expect(
      fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/tasks/counters')),
    ).toBe(true);
  });

  it('sem INBOX_VIEW não consulta os contadores', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ data: { permissions: [] } }));
    renderWithShell(<AppShell session={shellSession()}>x</AppShell>);
    const nav = screen.getByRole('navigation', { name: 'Menu principal' });
    await waitFor(() => {
      expect(within(nav).queryByRole('link', { name: 'Caixa de tarefas' })).toBeNull();
    });
    expect(within(nav).getByRole('link', { name: 'Aprovações' })).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/tasks/counters')),
    ).toBe(false);
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
    expect(within(dialog).getByRole('list', { name: 'Sistema' })).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: 'Minha conta' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Sair' })).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('link', { name: 'Processos' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('subitens da administração marcam a área atual (subrota incluída)', () => {
    pathname = '/admin/usuarios/123';
    renderWithShell(<MainNav />);
    const nav = screen.getByRole('navigation', { name: 'Menu principal' });
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe('Usuários');
    expect(isActivePath('/processosx', '/processos')).toBe(false);
  });

  it('cartão do usuário: "Sair" passa pelo LogoutGuard e confirma com rascunho não salvo', async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ data: { logoutUrl: 'https://idp.example/end-session' } }),
    );
    const navigate = vi.fn();
    const session = shellSession();
    const drafts = new LocalDrafts(new MemoryDraftBackend());
    await drafts.save({
      userId: session.user.id,
      tenantId: session.activeTenant.id,
      target: 'dfd:1:JUSTIFICATION',
      content: 'trecho',
      baseRevision: 1,
    });
    renderWithShell(
      <LogoutGuard drafts={drafts} onNavigate={navigate}>
        <UserCard />
      </LogoutGuard>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Sair' }));
    expect(
      await screen.findByRole('dialog', { name: 'Sair com alterações não salvas?' }),
    ).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Sair mesmo assim' }));
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('https://idp.example/end-session');
    });
  });
});

describe('[Tenant incorreto] seletor de instituição (US-093)', () => {
  /** Shell com o `<Toaster>` (que no app vem do `AppProviders`). */
  function renderSwitcher(options: Parameters<typeof renderWithShell>[1] = {}) {
    return renderWithShell(
      <>
        <AppShell session={options.session ?? shellSession()}>x</AppShell>
        <Toaster label="Notificações" closeLabel="Fechar" />
      </>,
      options,
    );
  }

  async function openSwitcher() {
    await userEvent.click(screen.getByRole('button', { name: 'Instituição ativa: Prefeitura A' }));
  }

  it('[Sucesso] troca para a Prefeitura B: limpa o cache antes de navegar ao início e avisa', async () => {
    const fetchMock = stubFetch((url) =>
      url === '/api/auth/switch-tenant'
        ? jsonResponse({ data: shellSession({ activeTenant: TENANT_B }) })
        : jsonResponse({ data: { permissions: [] } }),
    );
    const queryClient = new QueryClient();
    queryClient.setQueryData(tenantKey(TENANT_A.id, 'processes'), ['dado da Prefeitura A']);
    const order: string[] = [];
    router.push.mockImplementation(() => {
      order.push(`push:${String(queryClient.getQueryCache().getAll().length)}`);
    });
    renderSwitcher({ queryClient });
    await openSwitcher();
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Prefeitura B' }));
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    // RN-IAM-72: nenhum dado do tenant anterior quando a navegação começa.
    expect(order).toEqual(['push:0']);
    expect(router.push).toHaveBeenCalledWith('/painel');
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/auth/switch-tenant');
    const body = call?.[1]?.body;
    expect(JSON.parse(typeof body === 'string' ? body : '')).toEqual({ membershipId: 'm-b' });
    expect(queryClient.getQueryData(tenantKey(TENANT_A.id, 'processes'))).toBeUndefined();
    expect(await screen.findByText('Agora você está em Prefeitura B.')).toBeTruthy();
  });

  it('a instituição atual fica desabilitada; recusa MEMBERSHIP_INACTIVE avisa, remove da lista e mantém o cache', async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ code: 'MEMBERSHIP_INACTIVE' }, { status: 403 }),
    );
    const queryClient = new QueryClient();
    queryClient.setQueryData(tenantKey(TENANT_A.id, 'x'), 1);
    renderSwitcher({ queryClient });
    await openSwitcher();
    const current = await screen.findByRole('menuitem', { name: /Prefeitura A/ });
    expect(current.getAttribute('aria-disabled')).toBe('true');
    expect(current.getAttribute('aria-current')).toBe('true');
    await userEvent.click(current);
    // O sininho consulta o contador (NTF-02); a troca de instituição não é chamada.
    expect(
      fetchMock.mock.calls.filter(([input]) => requestUrl(input) === '/api/auth/switch-tenant'),
    ).toEqual([]);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Prefeitura B' }));
    expect(await screen.findByText('Você não tem mais acesso a esta instituição.')).toBeTruthy();
    expect(queryClient.getQueryData(tenantKey(TENANT_A.id, 'x'))).toBe(1);
    expect(router.refresh).not.toHaveBeenCalled();
    await openSwitcher();
    await screen.findByRole('menuitem', { name: 'Ver todas as instituições' });
    expect(screen.queryByRole('menuitem', { name: 'Prefeitura B' })).toBeNull();
    // Sem outra instituição utilizável: o seletor mostra só a atual (FA-03).
    expect(screen.getByText('Você tem acesso só a esta instituição.')).toBeTruthy();
  });

  it.each([
    [422, 'VALIDATION_ERROR', 'Selecione uma instituição válida.', true],
    [403, 'TENANT_SUSPENDED', 'Esta instituição está indisponível no momento.', false],
    [503, 'DEPENDENCY_UNAVAILABLE', 'Não foi possível trocar agora. Tente novamente.', false],
    [500, 'INTERNAL_ERROR', 'Não foi possível trocar de instituição.', false],
  ] as const)('recusa %s %s → toast "%s"', async (status, code, message, reloads) => {
    stubFetch(() => jsonResponse({ code }, { status }));
    renderSwitcher();
    await openSwitcher();
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Prefeitura B' }));
    expect(await screen.findByText(message)).toBeTruthy();
    // 422: a lista é recarregada do servidor ("Recarrega a lista").
    expect(router.refresh).toHaveBeenCalledTimes(reloads ? 1 : 0);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('[Falha de integração] destino exige MFA: segue ao step-up sem limpar nada', async () => {
    stubFetch(() =>
      jsonResponse(
        { code: 'MFA_REQUIRED', stepUpUrl: '/api/auth/step-up?returnTo=%2Fprocessos' },
        { status: 403 },
      ),
    );
    const assign = vi.fn();
    vi.stubGlobal('location', { href: window.location.href, assign });
    const queryClient = new QueryClient();
    queryClient.setQueryData(tenantKey(TENANT_A.id, 'x'), 1);
    renderSwitcher({ queryClient });
    await openSwitcher();
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Prefeitura B' }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('/api/auth/step-up?returnTo=%2Fprocessos');
    });
    expect(queryClient.getQueryData(tenantKey(TENANT_A.id, 'x'))).toBe(1);
    vi.unstubAllGlobals();
  });

  it('FA-03: com um único vínculo, mostra a instituição atual sem opção de troca', async () => {
    const session = shellSession();
    renderSwitcher({ session: { ...session, memberships: session.memberships.slice(0, 1) } });
    await openSwitcher();
    expect(
      (await screen.findByRole('menuitem', { name: /Prefeitura A/ })).getAttribute('aria-disabled'),
    ).toBe('true');
    expect(screen.getByText('Você tem acesso só a esta instituição.')).toBeTruthy();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Ver todas as instituições' }));
    expect(router.push).toHaveBeenCalledWith('/selecionar-orgao');
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

    postFromOtherTab({ type: 'tenant-switched', tenantId: TENANT_B.id });
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
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/auth/session');
  });

  it('aba visível recarrega na hora; mensagem do próprio tenant é ignorada', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(tenantKey(TENANT_A.id, 'x'), 1);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    renderWithShell(<SessionSync onNavigate={vi.fn()} />, { queryClient });
    postFromOtherTab({ type: 'tenant-switched', tenantId: TENANT_A.id });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(queryClient.getQueryData(tenantKey(TENANT_A.id, 'x'))).toBe(1);
    postFromOtherTab({ type: 'tenant-switched', tenantId: TENANT_B.id });
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalledTimes(1);
    });
  });

  it('logout em outra aba leva à SCR-001; foco sem sessão leva ao login', async () => {
    const navigate = vi.fn();
    stubFetch(() => jsonResponse({}, { status: 401 }));
    renderWithShell(<SessionSync onNavigate={navigate} />);
    postFromOtherTab({ type: 'logout' });
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('/entrar?motivo=saiu');
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
