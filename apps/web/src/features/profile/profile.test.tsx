// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import type { MyProfileDto } from '@contrataflow/validation';
import { configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, problem, renderWithShell, requestUrl } from '@test/support/render';

import { PreferencesApplier } from './preferences-applier';
import { buildPatch, displayNameOf, toDraft, validateDraft } from './profile-model';
import { ProfileView } from './profile-view';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => '/perfil',
}));

const LINKS = {
  password: 'https://idp.test/if/user/#/settings;page-details',
  mfa: 'https://idp.test/if/user/#/settings;page-mfa',
};

function profile(overrides: Partial<MyProfileDto> = {}): MyProfileDto {
  return {
    id: '0192a000-0000-7000-8000-0000000000a1',
    name: 'Elisa Prado',
    socialName: null,
    email: 'elisa@prefeitura-a.test',
    phone: null,
    preferences: { density: 'comfortable', theme: 'system' },
    membership: { jobTitle: 'Analista de Compras', departments: ['Compras', 'Licitações'] },
    version: 1,
    ...overrides,
  };
}

type Handler = (init?: RequestInit) => Response | Promise<Response>;

function mockApi(initial: MyProfileDto, onPatch?: Handler) {
  let current = initial;
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/v1/me' && method === 'GET') {
      return Promise.resolve(
        jsonResponse({ data: current }, { headers: { ETag: `"${String(current.version)}"` } }),
      );
    }
    if (url === '/api/v1/me' && method === 'PATCH') {
      if (onPatch) return Promise.resolve(onPatch(init));
      const body = JSON.parse(bodyOf(init)) as Partial<MyProfileDto>;
      current = {
        ...current,
        ...body,
        preferences: { ...current.preferences, ...body.preferences },
        version: current.version + 1,
      };
      return Promise.resolve(
        jsonResponse({ data: current }, { headers: { ETag: `"${String(current.version)}"` } }),
      );
    }
    return Promise.resolve(problem(404, 'NOT_FOUND'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Corpo JSON de um `fetch` simulado. */
function bodyOf(init: RequestInit | undefined): string {
  return typeof init?.body === 'string' ? init.body : '';
}

const patches = (api: ReturnType<typeof mockApi>) =>
  api.mock.calls.filter(([, init]) => init?.method === 'PATCH');

function renderProfile() {
  return renderWithShell(
    <>
      <PreferencesApplier />
      <ProfileView links={LINKS} />
      <Toaster label="Notificações" closeLabel="Fechar" />
    </>,
  );
}

const getsOfMe = (api: ReturnType<typeof mockApi>) =>
  api.mock.calls.filter(
    ([input, init]) => requestUrl(input) === '/api/v1/me' && (init?.method ?? 'GET') === 'GET',
  ).length;

const saveButton = () => screen.getByRole('button', { name: 'Salvar' });

afterEach(() => {
  vi.unstubAllGlobals();
  refresh.mockClear();
  clearToasts();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.density;
});

describe('profile-model (RN-IAM-109..110)', () => {
  it('valida nome (2–200), nome social e telefone BR; vazio é aceito só nos opcionais', () => {
    const base = toDraft(profile());
    expect(validateDraft(base)).toEqual({});
    expect(validateDraft({ ...base, name: 'A' })).toEqual({ name: 'name' });
    expect(validateDraft({ ...base, name: '   ' })).toEqual({ name: 'name' });
    expect(validateDraft({ ...base, socialName: 'E' })).toEqual({ socialName: 'socialName' });
    expect(validateDraft({ ...base, phone: '123' })).toEqual({ phone: 'phone' });
    expect(validateDraft({ ...base, socialName: '', phone: '(11) 91234-5678' })).toEqual({});
  });

  it('o corpo do PATCH leva só o que mudou; campo vazio vira null', () => {
    const loaded = profile({ socialName: 'Eli', phone: '(11) 91234-5678' });
    expect(buildPatch(toDraft(loaded), loaded)).toEqual({});
    expect(
      buildPatch(
        { ...toDraft(loaded), name: ' Elisa P. ', socialName: '', phone: '', theme: 'dark' },
        loaded,
      ),
    ).toEqual({ name: 'Elisa P.', socialName: null, phone: null, preferences: { theme: 'dark' } });
  });

  it('o nome social prevalece sobre o civil na exibição', () => {
    expect(displayNameOf({ name: 'Elisa Prado', socialName: 'Eli' })).toBe('Eli');
    expect(displayNameOf({ name: 'Elisa Prado', socialName: null })).toBe('Elisa Prado');
    expect(displayNameOf({ name: 'Elisa Prado', socialName: '  ' })).toBe('Elisa Prado');
  });
});

describe('SCR-039 — Meu perfil (US-098)', () => {
  it('[Carga] mostra os dados, o vínculo somente leitura e os atalhos do Authentik em nova aba', async () => {
    mockApi(profile());
    renderProfile();

    expect(await screen.findByRole('heading', { name: 'Meu perfil' })).toBeTruthy();
    const name = await screen.findByRole('textbox', { name: 'Nome' });
    expect((name as HTMLInputElement).value).toBe('Elisa Prado');
    const email = screen.getByLabelText<HTMLInputElement>('E-mail');
    expect(email.value).toBe('elisa@prefeitura-a.test');
    expect(email.readOnly).toBe(true);
    expect(screen.getByText('Analista de Compras')).toBeTruthy();
    expect(screen.getByText('Compras, Licitações')).toBeTruthy();
    const password = screen.getByRole('link', { name: /Alterar senha/ });
    expect(password.getAttribute('href')).toBe(LINKS.password);
    expect(password.getAttribute('target')).toBe('_blank');
    expect(password.getAttribute('rel')).toContain('noopener');
    expect(
      screen.getByRole('link', { name: /Autenticação em duas etapas/ }).getAttribute('href'),
    ).toBe(LINKS.mfa);
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('[Sucesso] salva nome social e tema com If-Match, avisa com aria-live e aplica o tema na hora', async () => {
    const api = mockApi(profile());
    renderProfile();
    await screen.findByRole('textbox', { name: 'Nome' });

    await userEvent.type(screen.getByLabelText('Nome social'), 'Eli');
    await userEvent.selectOptions(screen.getByLabelText('Tema'), 'dark');
    expect((saveButton() as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(saveButton());

    expect(await screen.findByText('Perfil atualizado')).toBeTruthy();
    // A região de toasts é `aria-live` (RN-FND-96).
    expect(document.querySelector('[aria-live]')).toBeTruthy();
    expect(patches(api)).toHaveLength(1);
    const [, init] = patches(api)[0] ?? [];
    expect(JSON.parse(bodyOf(init))).toEqual({
      socialName: 'Eli',
      preferences: { theme: 'dark' },
    });
    expect(new Headers(init?.headers).get('If-Match')).toBe('"1"');
    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('dark');
    });
    expect(refresh).toHaveBeenCalled();
    // Com a nova versão carregada, nada pendente: o botão volta a ficar desabilitado.
    await waitFor(() => {
      expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    });
    expect(screen.getByLabelText<HTMLInputElement>('Nome social').value).toBe('Eli');
  });

  it('[Validação] nome apagado mostra a mensagem da story e mantém "Salvar" desabilitado', async () => {
    const api = mockApi(profile());
    renderProfile();
    const name = await screen.findByRole('textbox', { name: 'Nome' });

    await userEvent.clear(name);
    await userEvent.tab();
    expect(await screen.findByText('Informe seu nome (mín. 2 caracteres).')).toBeTruthy();
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(await seriousA11yViolations()).toEqual([]);
    expect(patches(api)).toHaveLength(0);
  });

  it('[Validação] telefone fora do formato BR mostra "Informe um telefone válido."', async () => {
    mockApi(profile());
    renderProfile();
    await screen.findByRole('textbox', { name: 'Nome' });

    await userEvent.type(screen.getByLabelText('Telefone'), '12345');
    await userEvent.tab();
    expect(await screen.findByText('Informe um telefone válido.')).toBeTruthy();
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('FA-01: apagar o nome social envia null e volta a exibir o nome civil', async () => {
    const api = mockApi(profile({ socialName: 'Eli' }));
    renderProfile();
    const social = await screen.findByLabelText('Nome social');
    expect((social as HTMLInputElement).value).toBe('Eli');

    await userEvent.clear(social);
    await userEvent.click(saveButton());
    await screen.findByText('Perfil atualizado');
    const [, init] = patches(api)[0] ?? [];
    expect(JSON.parse(bodyOf(init))).toEqual({ socialName: null });
  });

  it('[Duplicidade] clique duplo em "Salvar" envia uma única requisição', async () => {
    let release: (response: Response) => void = () => undefined;
    const api = mockApi(profile(), () => new Promise<Response>((resolve) => (release = resolve)));
    renderProfile();
    await screen.findByRole('textbox', { name: 'Nome' });
    await userEvent.type(screen.getByLabelText('Nome social'), 'Eli');

    await userEvent.dblClick(saveButton());
    await waitFor(() => {
      expect(patches(api)).toHaveLength(1);
    });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Salvando…' }).disabled).toBe(
      true,
    );
    release(jsonResponse({ data: profile({ socialName: 'Eli', version: 2 }) }));
    await screen.findByText('Perfil atualizado');
    expect(patches(api)).toHaveLength(1);
  });

  it('[Concorrência] 412 VERSION_CONFLICT avisa, recarrega GET /me e pede para repetir a edição', async () => {
    const api = mockApi(profile(), () => problem(412, 'VERSION_CONFLICT'));
    renderProfile();
    await screen.findByRole('textbox', { name: 'Nome' });
    await userEvent.type(screen.getByLabelText('Nome social'), 'Eli');
    await userEvent.click(saveButton());

    expect(
      await screen.findByText('Seus dados foram atualizados em outra aba. Recarregue.'),
    ).toBeTruthy();
    // O front recarrega GET /me (ME-01): uma leitura inicial e outra depois do conflito.
    await waitFor(() => {
      expect(getsOfMe(api)).toBeGreaterThanOrEqual(2);
    });
  });

  it('[Falha de banco] 503 mantém os dados preenchidos e oferece "Tentar novamente"', async () => {
    let attempts = 0;
    const api = mockApi(profile(), () => {
      attempts += 1;
      return attempts === 1
        ? problem(503, 'DEPENDENCY_UNAVAILABLE')
        : jsonResponse({ data: profile({ socialName: 'Eli', version: 2 }) });
    });
    renderProfile();
    await screen.findByRole('textbox', { name: 'Nome' });
    await userEvent.type(screen.getByLabelText('Nome social'), 'Eli');
    await userEvent.click(saveButton());

    expect(await screen.findByText('Não foi possível salvar agora. Tente novamente.')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Nome social').value).toBe('Eli');
    await userEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await screen.findByText('Perfil atualizado');
    expect(patches(api)).toHaveLength(2);
  });

  it('erro ao carregar oferece "Tentar novamente"', async () => {
    let fail = true;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(() =>
        Promise.resolve(fail ? problem(500, 'INTERNAL_ERROR') : jsonResponse({ data: profile() })),
      ),
    );
    renderProfile();

    expect(await screen.findByText('Não foi possível carregar seu perfil.')).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('textbox', { name: 'Nome' })).toBeTruthy();
  });
});

describe('PreferencesApplier', () => {
  it('aplica tema e densidade do perfil ao documento', async () => {
    mockApi(profile({ preferences: { density: 'compact', theme: 'dark' } }));
    renderWithShell(<PreferencesApplier />);
    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('dark');
    });
    expect(document.documentElement.dataset.density).toBe('compact');
  });

  it('falha ao carregar não afeta o documento nem derruba o shell', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(() => Promise.resolve(problem(500, 'INTERNAL_ERROR'))),
    );
    renderWithShell(<PreferencesApplier />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});
