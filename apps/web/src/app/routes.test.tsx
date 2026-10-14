// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { messages } from '@/i18n/messages';
import type { ActiveShellSession } from '@/lib/session/types';
import { seriousA11yViolations } from '@test/support/axe';
import { IntlProvider, TENANT_A, requestUrl, shellSession } from '@test/support/render';

import AdminLayout from './(app)/admin/layout';
import AdminHomePage from './(app)/admin/page';
import AppError from './(app)/error';
import ExamplePage from './(app)/exemplo/page';
import AppLayout from './(app)/layout';
import AppLoading from './(app)/loading';
import InvitePage from './(auth)/convite/[token]/page';
import LoginPage from './(auth)/entrar/page';
import ErrorPage, { generateMetadata } from './(auth)/erro/[variante]/page';
import AuthLayout from './(auth)/layout';
import PasswordRecoveryPage from './(auth)/recuperar-senha/page';
import SelectTenantPage from './(auth)/selecionar-orgao/page';
import NotFound from './not-found';

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT ${url}`);
  }
}

interface ServerState {
  lookup: { status: string; record?: unknown };
  pathname: string;
  shell: ActiveShellSession | null;
  get: ReturnType<typeof vi.fn<(path: string, options?: unknown) => Promise<unknown>>>;
}

const server: ServerState = vi.hoisted(() => ({
  lookup: { status: 'none' },
  pathname: '/processos?x=1',
  shell: null,
  get: vi.fn<(path: string, options?: unknown) => Promise<unknown>>(),
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => '/exemplo',
}));

vi.mock('next-intl/server', () => ({
  getTranslations: (namespace?: string) =>
    Promise.resolve(createTranslator({ locale: 'pt-BR', messages, namespace: namespace as never })),
}));

vi.mock('@/bff/server-session', () => ({
  currentSession: () => Promise.resolve(server.lookup),
  currentPathname: () => Promise.resolve(server.pathname),
  currentShellSession: () => Promise.resolve(server.shell),
  apiServerClient: { get: server.get },
}));

beforeEach(() => {
  server.lookup = { status: 'none' };
  server.shell = null;
  server.get.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function redirectOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RedirectSignal) return error.url;
    throw error;
  }
  throw new Error('Esperava redirecionamento.');
}

function renderIntl(element: ReactElement) {
  return render(<IntlProvider>{element}</IntlProvider>);
}

const RECORD = {
  key: 'k',
  userId: 'u',
  subject: 'sub-ana',
  displayName: 'Ana Souza',
  activeTenantId: TENANT_A.id,
  membershipId: 'm-a',
  memberships: [{ membershipId: 'm-a', tenant: TENANT_A, usable: true }],
  tokens: { accessToken: 'segredo', accessTokenExpiresAt: 0, refreshToken: null },
  amr: ['pwd'],
  createdAt: 0,
  lastSeenAt: 0,
  idleExpiresAt: 0,
  absoluteExpiresAt: 0,
};

describe('RN-FND-87 — layout de (app) resolve sessão e tenant no servidor', () => {
  it('V-03 / FA-01: sem sessão → login com returnTo da rota original', async () => {
    expect(await redirectOf(AppLayout({ children: null }))).toBe(
      '/api/auth/login?returnTo=%2Fprocessos%3Fx%3D1',
    );
    server.lookup = { status: 'expired' };
    expect(await redirectOf(AppLayout({ children: null }))).toContain('/api/auth/login?returnTo=');
  });

  it('FA-02: sessão sem tenant ativo → /selecionar-orgao', async () => {
    server.lookup = { status: 'active', record: { ...RECORD, activeTenantId: null } };
    expect(await redirectOf(AppLayout({ children: null }))).toBe('/selecionar-orgao');
  });

  it('sessão com tenant → shell com o conteúdo e sem tokens no HTML', async () => {
    server.lookup = { status: 'active', record: RECORD };
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ data: { permissions: [] } }))),
    );
    const element = await AppLayout({ children: <p>Conteúdo protegido</p> });
    const { container } = render(element);
    expect(screen.getByText('Conteúdo protegido')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Menu principal' })).toBeTruthy();
    expect(container.innerHTML).not.toContain('segredo');
  });
});

describe('SCR-111 — páginas /erro/*', () => {
  const variants = [
    ['403', 'Acesso negado', 'Ir para o início'],
    ['404', 'Página não encontrada ou sem acesso', 'Ir para o início'],
    ['500', 'Ocorreu um erro inesperado', 'Tentar novamente'],
    ['sessao-expirada', 'Sua sessão expirou', 'Entrar novamente'],
    ['manutencao', 'Sistema temporariamente indisponível', 'Tentar novamente'],
    ['sem-vinculo', 'Seu acesso a este órgão não está ativo', 'Trocar de instituição'],
    ['acesso-indisponivel', 'Acesso indisponível', 'Trocar de instituição'],
  ] as const;

  it.each(variants)(
    '%s: título, explicação e ação primária, sem violação de a11y',
    async (variante, title, action) => {
      const element = await ErrorPage({
        params: Promise.resolve({ variante }),
        searchParams: Promise.resolve({ retorno: '/processos', codigo: 'c-111' }),
      });
      renderIntl(element);
      const heading = screen.getByRole('heading', { level: 1, name: title });
      expect(document.activeElement).toBe(heading);
      expect(screen.getByRole('link', { name: action })).toBeTruthy();
      expect(screen.getByText('Código: c-111')).toBeTruthy();
      expect(await seriousA11yViolations()).toEqual([]);
      expect(
        (
          await generateMetadata({
            params: Promise.resolve({ variante }),
            searchParams: Promise.resolve({}),
          })
        ).title,
      ).toBe(`${title} — ContrataFlow`);
    },
  );

  it('retorno e código são validados (sem open redirect nem injeção)', async () => {
    const element = await ErrorPage({
      params: Promise.resolve({ variante: 'sessao-expirada' }),
      searchParams: Promise.resolve({ retorno: ['//evil.com'], codigo: '<script>' }),
    });
    renderIntl(element);
    expect(screen.getByRole('link', { name: 'Entrar novamente' }).getAttribute('href')).toBe(
      '/api/auth/login?returnTo=%2Fexemplo',
    );
    expect(screen.queryByText(/Código/)).toBeNull();
  });

  it('variante desconhecida → 404', async () => {
    await expect(
      ErrorPage({
        params: Promise.resolve({ variante: 'xpto' }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(
      await generateMetadata({
        params: Promise.resolve({ variante: 'xpto' }),
        searchParams: Promise.resolve({}),
      }),
    ).toEqual({});
  });

  it('not-found global com a mensagem única', async () => {
    renderIntl(await NotFound());
    expect(
      screen.getByRole('heading', { name: 'Página não encontrada ou sem acesso' }),
    ).toBeTruthy();
  });
});

describe('grupo (auth)', () => {
  it('/entrar sem motivo segue direto para o login; com motivo mostra a mensagem', async () => {
    expect(
      await redirectOf(LoginPage({ searchParams: Promise.resolve({ returnTo: '/processos' }) })),
    ).toBe('/api/auth/login?returnTo=%2Fprocessos');
    expect(await redirectOf(LoginPage({ searchParams: Promise.resolve({}) }))).toBe(
      '/api/auth/login',
    );
    renderIntl(await LoginPage({ searchParams: Promise.resolve({ motivo: 'sessao-expirada' }) }));
    expect(screen.getByRole('status').textContent).toContain(
      'Sua sessão expirou. Entre novamente.',
    );
    expect(screen.getByRole('link', { name: 'Entrar' }).getAttribute('href')).toBe(
      '/api/auth/login',
    );
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('/entrar?motivo=erro usa o tom de aviso', async () => {
    renderIntl(
      await LoginPage({ searchParams: Promise.resolve({ motivo: 'erro', returnTo: '/x' }) }),
    );
    expect(screen.getByRole('status').className).toContain('bg-warning-soft');
    expect(screen.getByRole('link', { name: 'Entrar' }).getAttribute('href')).toBe(
      '/api/auth/login?returnTo=%2Fx',
    );
  });

  it('/selecionar-orgao: sem sessão → login; sem vínculo → /erro/sem-vinculo; senão a lista', async () => {
    expect(await redirectOf(SelectTenantPage())).toBe(
      '/api/auth/login?returnTo=%2Fselecionar-orgao',
    );
    server.shell = shellSession({ memberships: [] });
    expect(await redirectOf(SelectTenantPage())).toBe('/erro/sem-vinculo');
    server.shell = shellSession();
    renderIntl(await SelectTenantPage());
    expect(screen.getByRole('button', { name: 'Prefeitura B' })).toBeTruthy();
  });

  it('rotas reservadas e layout mínimo sem shell', async () => {
    renderIntl(
      <AuthLayout>
        <>
          {await PasswordRecoveryPage()}
          {await InvitePage()}
        </>
      </AuthLayout>,
    );
    expect(screen.getByRole('heading', { name: 'Recuperar senha' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Aceite de convite' })).toBeTruthy();
    expect(screen.queryByRole('navigation')).toBeNull();
  });
});

describe('(app): exemplo, admin, loading e error', () => {
  it('página de exemplo hidrata o cache com o prefetch do servidor', async () => {
    server.shell = shellSession();
    server.get.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/_internal/ping'
          ? {
              data: { status: 'ok', correlationId: 'c-rsc', tenantId: TENANT_A.id },
              status: 200,
              meta: { etag: null },
            }
          : {
              data: [{ id: 'item-01', position: 1 }],
              status: 200,
              meta: { totalItems: 1, totalPages: 1 },
            },
      ),
    );
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ data: { permissions: [] } })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { renderWithShell } = await import('@test/support/render');
    renderWithShell(await ExamplePage());
    expect(screen.getByRole('heading', { level: 1, name: 'Exemplo do shell' })).toBeTruthy();
    expect(screen.getByText('c-rsc')).toBeTruthy();
    expect(screen.getByText('item-01')).toBeTruthy();
    expect(server.get).toHaveBeenCalledWith('/_internal/items', {
      query: { page: 1, pageSize: 10 },
    });
    expect(
      fetchMock.mock.calls.every(([url]) => requestUrl(url) === '/api/v1/me/permissions'),
    ).toBe(true);
  });

  it('prefetch que falha não derruba a página (o cliente refaz a consulta)', async () => {
    server.shell = shellSession();
    server.get.mockRejectedValue(new Error('API fora'));
    const element = await ExamplePage();
    expect(element).toBeTruthy();
    server.shell = null;
    expect(await ExamplePage()).toBeTruthy();
  });

  it('admin com navegação própria; loading anuncia o carregamento', async () => {
    const { renderWithShell } = await import('@test/support/render');
    renderWithShell(<AdminLayout>{await AdminHomePage()}</AdminLayout>);
    expect(screen.getByRole('navigation', { name: 'Navegação de administração' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Administração' })).toBeTruthy();
    renderIntl(<AppLoading />);
    expect(screen.getByText('Carregando…')).toBeTruthy();
  });

  it('error.tsx do segmento delega ao SegmentError', async () => {
    const { renderWithShell } = await import('@test/support/render');
    const { ApiError } = await import('@/lib/api/api-error');
    renderWithShell(
      <AppError
        error={new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c-x' })}
        retry={vi.fn()}
      />,
    );
    expect(screen.getByText('Código: c-x')).toBeTruthy();
  });
});
