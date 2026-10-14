// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator } from 'next-intl';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { messages } from '@/i18n/messages';
import type { ActiveShellSession } from '@/lib/session/types';
import { seriousA11yViolations } from '@test/support/axe';
import { IntlProvider, TENANT_A, TENANT_B, requestUrl, shellSession } from '@test/support/render';

import AdminLayout from './(app)/admin/layout';
import AdminHomePage from './(app)/admin/page';
import AppError from './(app)/error';
import ExamplePage from './(app)/exemplo/page';
import AppLayout from './(app)/layout';
import AppLoading from './(app)/loading';
import InvitePage from './(auth)/convite/[token]/page';
import LoginPage, { generateMetadata as loginMetadata } from './(auth)/entrar/page';
import ErrorPage, { generateMetadata } from './(auth)/erro/[variante]/page';
import AuthLayout from './(auth)/layout';
import PasswordRecoveryPage from './(auth)/recuperar-senha/page';
import SelectTenantPage, {
  generateMetadata as selectionMetadata,
} from './(auth)/selecionar-orgao/page';
import NotFound from './not-found';

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT ${url}`);
  }
}

interface ServerState {
  lookup: { status: string; record?: unknown };
  pathname: string;
  /** `usePathname()` dos Client Components (caminho no navegador). */
  clientPathname: string;
  shell: ActiveShellSession | null;
  get: ReturnType<typeof vi.fn<(path: string, options?: unknown) => Promise<unknown>>>;
}

const server: ServerState = vi.hoisted(() => ({
  lookup: { status: 'none' },
  pathname: '/processos?x=1',
  clientPathname: '/exemplo',
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
  usePathname: () => server.clientPathname,
}));

vi.mock('next-intl/server', () => ({
  getTranslations: (namespace?: string) =>
    Promise.resolve(createTranslator({ locale: 'pt-BR', messages, namespace: namespace as never })),
}));

vi.mock('@/bff/server-session', () => ({
  currentSession: () => Promise.resolve(server.lookup),
  currentSessionOrUnavailable: () => Promise.resolve(server.lookup),
  currentPathname: () => Promise.resolve(server.pathname),
  currentShellSession: () => Promise.resolve(server.shell),
  apiServerClient: { get: server.get },
}));

beforeEach(() => {
  server.lookup = { status: 'none' };
  server.clientPathname = '/exemplo';
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

function membershipRecord(overrides: Record<string, unknown> = {}) {
  return {
    membershipId: 'm-a',
    tenant: TENANT_A,
    type: 'INTERNAL',
    status: 'ACTIVE',
    expiresAt: null,
    usable: true,
    readOnly: false,
    ...overrides,
  };
}

const RECORD = {
  key: 'k',
  userId: 'u',
  subject: 'sub-ana',
  displayName: 'Ana Souza',
  activeTenantId: TENANT_A.id,
  membershipId: 'm-a',
  memberships: [membershipRecord()],
  tokens: { accessToken: 'segredo', accessTokenExpiresAt: 0, refreshToken: null, idToken: null },
  amr: ['pwd'],
  authTime: null,
  firstLogin: false,
  ip: null,
  userAgentHash: null,
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

  it('FA-02: sessão sem tenant ativo → /selecionar-orgao com o returnTo da rota original', async () => {
    server.lookup = { status: 'active', record: { ...RECORD, activeTenantId: null } };
    expect(await redirectOf(AppLayout({ children: null }))).toBe(
      '/selecionar-orgao?returnTo=%2Fprocessos%3Fx%3D1',
    );
  });

  it('Redis de sessões indisponível → /erro/manutencao com o retorno (nunca "sem sessão")', async () => {
    server.lookup = { status: 'unavailable' };
    expect(await redirectOf(AppLayout({ children: null }))).toBe(
      '/erro/manutencao?retorno=%2Fprocessos%3Fx%3D1',
    );
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
    ['403', 'Acesso negado', 'link', 'Ir para o início'],
    ['404', 'Página não encontrada ou sem acesso', 'link', 'Ir para o início'],
    ['500', 'Ocorreu um erro inesperado', 'link', 'Tentar novamente'],
    ['sessao-expirada', 'Sua sessão expirou', 'link', 'Entrar novamente'],
    ['manutencao', 'Sistema temporariamente indisponível', 'link', 'Tentar novamente'],
    ['acesso-indisponivel', 'Acesso indisponível', 'link', 'Trocar de instituição'],
  ] as const;

  it.each(variants)(
    '%s: título, explicação e ação primária, sem violação de a11y',
    async (variante, title, role, action) => {
      const element = await ErrorPage({
        params: Promise.resolve({ variante }),
        searchParams: Promise.resolve({ retorno: '/processos', codigo: 'c-111-0001' }),
      });
      renderIntl(element);
      const heading = screen.getByRole('heading', { level: 1, name: title });
      expect(document.activeElement).toBe(heading);
      expect(screen.getByRole(role, { name: action })).toBeTruthy();
      expect(screen.getByText('Código: c-111-0001')).toBeTruthy();
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

  it('manutencao: "Tentar novamente" volta ao retorno validado, com o código copiável', async () => {
    renderIntl(
      await ErrorPage({
        params: Promise.resolve({ variante: 'manutencao' }),
        searchParams: Promise.resolve({ retorno: '/processos?x=1', codigo: 'c-111-0002' }),
      }),
    );
    expect(screen.getByRole('link', { name: 'Tentar novamente' }).getAttribute('href')).toBe(
      '/processos?x=1',
    );
    expect(screen.getByRole('button', { name: 'Copiar código' })).toBeTruthy();
  });

  it.each([
    [
      'sem-vinculo',
      'Sua conta não tem acesso ativo a nenhuma instituição',
      'Se você recebeu um convite, abra o link enviado por e-mail. Em caso de dúvida, procure o administrador da sua instituição.',
    ],
    [
      'acesso-bloqueado',
      'Seu acesso ao ContrataFlow está bloqueado',
      'Procure o suporte da sua instituição.',
    ],
  ] as const)(
    '%s: título, explicação e só a ação "Sair", sem violação de a11y',
    async (variante, title, description) => {
      const element = await ErrorPage({
        params: Promise.resolve({ variante }),
        searchParams: Promise.resolve({}),
      });
      renderIntl(element);
      const heading = screen.getByRole('heading', { level: 1, name: title });
      expect(document.activeElement).toBe(heading);
      expect(screen.getByText(new RegExp(description))).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Sair' })).toBeTruthy();
      expect(screen.queryByRole('link')).toBeNull();
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

  it('"Sair" encerra a sessão no BFF e segue para o destino devolvido (fim de sessão no provedor)', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({ data: { redirectTo: 'https://idp.example/fim-de-sessao?x=1' } }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const assign = vi.fn();
    vi.stubGlobal('location', { href: window.location.href, assign });
    renderIntl(
      await ErrorPage({
        params: Promise.resolve({ variante: 'sem-vinculo' }),
        searchParams: Promise.resolve({}),
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Sair' }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('https://idp.example/fim-de-sessao?x=1');
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/auth/logout');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('X-CF-Request')).toBe('1');
  });

  it('"Sair" sem resposta útil do BFF cai em /entrar?motivo=saiu', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { href: window.location.href, assign });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 500 }))),
    );
    renderIntl(
      await ErrorPage({
        params: Promise.resolve({ variante: 'acesso-bloqueado' }),
        searchParams: Promise.resolve({}),
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Sair' }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('/entrar?motivo=saiu');
    });
  });

  it('"Sair" com falha de rede avisa que a sessão continua e permite repetir', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { href: window.location.href, assign });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    renderIntl(
      await ErrorPage({
        params: Promise.resolve({ variante: 'sem-vinculo' }),
        searchParams: Promise.resolve({}),
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Sair' }));
    expect((await screen.findAllByRole('alert')).at(-1)?.textContent).toContain(
      'Não foi possível sair agora. Tente novamente.',
    );
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Sair' }).getAttribute('aria-busy')).toBe('false');
  });

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

describe('SCR-001 — /entrar', () => {
  const REASON_MESSAGES = [
    ['saiu', 'Você saiu do ContrataFlow.', 'bg-primary-soft'],
    [
      'saiu-parcial',
      'Você saiu do ContrataFlow, mas a sessão no provedor de identidade pode continuar ativa neste navegador. Feche o navegador para concluir.',
      'bg-warning-soft',
    ],
    [
      'sessao-expirada',
      'Sua sessão expirou por inatividade. Entre novamente para continuar de onde parou.',
      'bg-primary-soft',
    ],
    ['senha-redefinida', 'Senha redefinida. Entre com sua nova senha.', 'bg-primary-soft'],
    ['erro', 'Não foi possível concluir a entrada. Tente novamente.', 'bg-warning-soft'],
    [
      'indisponivel',
      'O serviço de autenticação está indisponível. Tente novamente em instantes.',
      'bg-warning-soft',
    ],
  ] as const;

  /** Impede a navegação real do jsdom ao clicar em links. */
  function blockNavigation() {
    const block = (event: Event) => {
      event.preventDefault();
    };
    document.addEventListener('click', block);
    return () => {
      document.removeEventListener('click', block);
    };
  }

  it('sem motivo segue direto para o login do BFF, preservando o returnTo validado', async () => {
    expect(
      await redirectOf(LoginPage({ searchParams: Promise.resolve({ returnTo: '/processos' }) })),
    ).toBe('/api/auth/login?returnTo=%2Fprocessos');
    expect(await redirectOf(LoginPage({ searchParams: Promise.resolve({}) }))).toBe(
      '/api/auth/login',
    );
    // Motivo desconhecido não renderiza nada próprio.
    expect(
      await redirectOf(LoginPage({ searchParams: Promise.resolve({ motivo: '<script>' }) })),
    ).toBe('/api/auth/login');
  });

  it('returnTo externo é descartado (open redirect)', async () => {
    expect(
      await redirectOf(LoginPage({ searchParams: Promise.resolve({ returnTo: '//evil.com/x' }) })),
    ).toBe('/api/auth/login');
    renderIntl(
      await LoginPage({
        searchParams: Promise.resolve({ motivo: 'erro', returnTo: 'https://evil.com' }),
      }),
    );
    expect(screen.getByRole('link', { name: 'Entrar' }).getAttribute('href')).toBe(
      '/api/auth/login',
    );
  });

  it('FA-07: já autenticado volta para o returnTo (ou o início), sem novo login', async () => {
    server.lookup = { status: 'active', record: RECORD };
    expect(
      await redirectOf(
        LoginPage({ searchParams: Promise.resolve({ returnTo: '/processos?x=1' }) }),
      ),
    ).toBe('/processos?x=1');
    expect(await redirectOf(LoginPage({ searchParams: Promise.resolve({}) }))).toBe('/exemplo');
    // Mesmo com motivo, e nunca de volta para a própria entrada.
    expect(
      await redirectOf(
        LoginPage({ searchParams: Promise.resolve({ motivo: 'saiu', returnTo: '/entrar?x=1' }) }),
      ),
    ).toBe('/exemplo');
  });

  it('Redis de sessões indisponível: a página continua acessível e segue o fluxo normal', async () => {
    server.lookup = { status: 'unavailable' };
    expect(
      await redirectOf(LoginPage({ searchParams: Promise.resolve({ returnTo: '/processos' }) })),
    ).toBe('/api/auth/login?returnTo=%2Fprocessos');
    renderIntl(await LoginPage({ searchParams: Promise.resolve({ motivo: 'indisponivel' }) }));
    expect(screen.getByRole('heading', { level: 1, name: 'Acesse sua conta' })).toBeTruthy();
  });

  it.each(REASON_MESSAGES)(
    'motivo %s: mensagem em role=status e botão "Entrar"',
    async (motivo, message, tone) => {
      renderIntl(await LoginPage({ searchParams: Promise.resolve({ motivo }) }));
      const status = screen.getByRole('status');
      expect(status.textContent).toBe(message);
      expect(status.className).toContain(tone);
      expect(screen.getByRole('link', { name: 'Entrar' }).getAttribute('href')).toBe(
        '/api/auth/login',
      );
    },
  );

  it('moldura de login: título focado, Entrar com returnTo, esqueci a senha, ajuda e painel — sem gov.br, sem violação de a11y', async () => {
    renderIntl(
      await LoginPage({
        searchParams: Promise.resolve({ motivo: 'sessao-expirada', returnTo: '/processos?x=1' }),
      }),
    );
    const heading = screen.getByRole('heading', { level: 1, name: 'Acesse sua conta' });
    expect(document.activeElement).toBe(heading);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('Entre para continuar no ContrataFlow.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Entrar' }).getAttribute('href')).toBe(
      '/api/auth/login?returnTo=%2Fprocessos%3Fx%3D1',
    );
    expect(screen.getByRole('link', { name: 'Esqueci minha senha' }).getAttribute('href')).toBe(
      '/recuperar-senha',
    );
    expect(screen.getByRole('link', { name: 'Suporte' }).getAttribute('href')).toMatch(/^mailto:/);
    expect(screen.getByText(/Precisa de ajuda\?/)).toBeTruthy();
    // Painel institucional (decorativo) e selo de privacidade.
    for (const text of [
      'Contratações públicas mais simples, seguras e eficientes.',
      'Da demanda à publicação, todo o processo em um único lugar.',
      'Processos padronizados',
      'ETP, TR, pesquisas, riscos e mais.',
      'Tramitação e aprovações',
      'Fluxos personalizados por órgão.',
      'Transparência e controle',
      'Acompanhamento em tempo real.',
      'Tecnologia a serviço da gestão pública.',
      'Planejamento, conformidade e resultados.',
      'Ambiente seguro',
    ]) {
      expect(screen.getByText(text)).toBeTruthy();
    }
    expect(document.querySelector('img[src="/login-predio.svg"]')?.getAttribute('alt')).toBe('');
    // Sem login gov.br no MVP 1 (PEND-18) e sem dados de instituição.
    expect(screen.queryByText(/gov\.br/i)).toBeNull();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('"Entrar" mostra "Redirecionando…" após o clique e ignora o segundo clique', async () => {
    const unblock = blockNavigation();
    renderIntl(await LoginPage({ searchParams: Promise.resolve({ motivo: 'saiu' }) }));
    await userEvent.click(screen.getByRole('link', { name: 'Entrar' }));
    const busy = screen.getByRole('link', { name: 'Redirecionando…' });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    const secondClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    busy.dispatchEvent(secondClick);
    expect(secondClick.defaultPrevented).toBe(true);
    // Voltar do provedor pelo histórico (bfcache) restaura o botão.
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    expect(screen.getByRole('link', { name: 'Entrar' }).getAttribute('aria-busy')).toBe('false');
    unblock();
  });

  it('"Saiba mais" abre o aviso de privacidade completo', async () => {
    renderIntl(await LoginPage({ searchParams: Promise.resolve({ motivo: 'saiu' }) }));
    expect(
      screen.getByText('Seus dados são protegidos e utilizados conforme a LGPD.', {
        exact: false,
      }),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Saiba mais' }));
    const dialog = await screen.findByRole('dialog', { name: 'Privacidade e proteção de dados' });
    expect(dialog.textContent).toContain(
      'Seus dados de acesso são tratados pela instituição contratante, controladora dos dados, para a execução de políticas públicas e o cumprimento de obrigações legais (LGPD, art. 7º, II e III, e art. 23).',
    );
    expect(within(dialog).getByText(/Consulte a/).textContent).toBe(
      'Consulte a Política de privacidade e os Termos de uso.',
    );
    expect(within(dialog).getByRole('link', { name: 'Política de privacidade' })).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: 'Termos de uso' })).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Fechar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('metadata com o título da página', async () => {
    expect((await loginMetadata()).title).toBe('Entrar — ContrataFlow');
  });
});

describe('SCR-101 — /selecionar-orgao', () => {
  const SELECTION = [
    membershipRecord(),
    membershipRecord({
      membershipId: 'm-b',
      tenant: { ...TENANT_B, name: 'Câmara Municipal de Vila Nova' },
      type: 'EXTERNAL',
      expiresAt: '2026-12-31T23:59:59-03:00',
    }),
    membershipRecord({
      membershipId: 'm-c',
      tenant: { ...TENANT_B, id: 'tenant-c', name: 'Prefeitura C', status: 'SUSPENDED' },
      usable: false,
    }),
  ];

  function selectionRecord(memberships: readonly unknown[] = SELECTION) {
    return { ...RECORD, activeTenantId: null, membershipId: null, memberships };
  }

  function pageProps(query: Record<string, string | string[] | undefined> = {}) {
    return { searchParams: Promise.resolve(query) };
  }

  it('sem sessão → login; Redis fora → manutenção; sem vínculo utilizável → /erro/sem-vinculo', async () => {
    expect(await redirectOf(SelectTenantPage(pageProps()))).toBe(
      '/api/auth/login?returnTo=%2Fselecionar-orgao',
    );
    server.lookup = { status: 'expired' };
    expect(await redirectOf(SelectTenantPage(pageProps()))).toBe(
      '/api/auth/login?returnTo=%2Fselecionar-orgao',
    );
    server.lookup = { status: 'unavailable' };
    expect(await redirectOf(SelectTenantPage(pageProps()))).toBe(
      '/erro/manutencao?retorno=%2Fselecionar-orgao',
    );
    server.lookup = { status: 'active', record: selectionRecord([]) };
    expect(await redirectOf(SelectTenantPage(pageProps()))).toBe('/erro/sem-vinculo');
    server.lookup = {
      status: 'active',
      record: selectionRecord([membershipRecord({ usable: false })]),
    };
    expect(await redirectOf(SelectTenantPage(pageProps()))).toBe('/erro/sem-vinculo');
  });

  it('lista as instituições com vínculo externo, validade e indisponíveis desabilitadas — sem violação de a11y', async () => {
    server.lookup = { status: 'active', record: selectionRecord() };
    renderIntl(await SelectTenantPage(pageProps({ returnTo: '/processos' })));
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Olá, Ana. Em qual instituição você vai trabalhar?',
      }),
    ).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Instituições disponíveis' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    const external = screen.getByRole('button', { name: /Câmara Municipal de Vila Nova/ });
    expect(external.textContent).toContain('Vínculo externo');
    expect(external.textContent).toContain('Válido até 31/12/2026');
    const blocked = screen.getByRole('button', { name: /Prefeitura C/ });
    expect(blocked.getAttribute('aria-disabled')).toBe('true');
    expect(blocked.textContent).toContain('Instituição temporariamente indisponível');
    expect(screen.getByRole('button', { name: 'Sair' })).toBeTruthy();
    expect(
      screen.getByText(
        'Não encontrou sua instituição? Peça ao administrador do órgão um convite para o seu e-mail.',
      ),
    ).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('um único vínculo utilizável (sem instituição ativa) ainda mostra a lista', async () => {
    server.lookup = { status: 'active', record: selectionRecord([membershipRecord()]) };
    renderIntl(await SelectTenantPage(pageProps()));
    expect(screen.getByRole('button', { name: /Prefeitura A/ })).toBeTruthy();
  });

  it('a escolha segue para o returnTo validado no servidor; inválido vira o início', async () => {
    server.lookup = { status: 'active', record: selectionRecord() };
    const assign = vi.fn();
    vi.stubGlobal('location', { href: window.location.href, assign });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ data: {} }))),
    );
    const first = renderIntl(await SelectTenantPage(pageProps({ returnTo: '/processos/1?x=2' })));
    await userEvent.click(screen.getByRole('button', { name: /Prefeitura A/ }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('/processos/1?x=2');
    });
    first.unmount();

    assign.mockClear();
    renderIntl(await SelectTenantPage(pageProps({ returnTo: '//evil.com' })));
    await userEvent.click(screen.getByRole('button', { name: /Prefeitura A/ }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('/exemplo');
    });
  });

  it('metadata com o título da página', async () => {
    expect((await selectionMetadata()).title).toBe('Escolha a instituição — ContrataFlow');
  });
});

describe('grupo (auth): casca', () => {
  it('/entrar não duplica a marca no cabeçalho; as demais páginas do grupo mantêm o cabeçalho', () => {
    server.clientPathname = '/entrar';
    const login = renderIntl(
      <AuthLayout>
        <p>Moldura de login</p>
      </AuthLayout>,
    );
    expect(screen.getByRole('main').textContent).toBe('Moldura de login');
    expect(screen.queryByText('ContrataFlow')).toBeNull();
    expect(login.container.querySelector('.bg-linear-to-br')).toBeTruthy();
    login.unmount();

    server.clientPathname = '/recuperar-senha';
    renderIntl(
      <AuthLayout>
        <p>Conteúdo</p>
      </AuthLayout>,
    );
    expect(screen.getByText('ContrataFlow')).toBeTruthy();
    expect(screen.getByRole('main').textContent).toBe('Conteúdo');
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
