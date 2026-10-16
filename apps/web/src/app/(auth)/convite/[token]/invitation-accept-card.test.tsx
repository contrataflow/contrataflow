// @vitest-environment jsdom
import { configure, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { IntlProvider, jsonResponse, requestUrl } from '@test/support/render';

import { InvitationAcceptCard } from './invitation-accept-card';

configure({ asyncUtilTimeout: 5000 });

const TOKEN = 'Ab3_-'.repeat(8) + 'Ab3'; // 43 caracteres base64url
const replace = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, refresh }),
}));

const MEMBERSHIP_ID = '0192a000-0000-7000-8000-0000000002a1';

const PREVIEW = {
  tenant: { id: '0192a000-0000-7000-8000-00000000000b', name: 'Prefeitura B' },
  type: 'EXTERNAL',
  jobTitle: 'Fiscal de contrato',
  departments: [
    { id: '0192a000-0000-7000-8000-0000000000d1', name: 'Secretaria de Obras' },
    { id: '0192a000-0000-7000-8000-0000000000d2', name: 'Protocolo' },
  ],
  expiresAt: '2027-01-31T02:59:59.999Z',
  inviteExpiresAt: '2026-10-22T12:00:00.000Z',
};

function problemResponse(status: number, code: string, detail: string): Response {
  return new Response(
    JSON.stringify({
      type: `https://docs.contrataflow.com.br/errors/${code.toLowerCase()}`,
      title: code,
      status,
      detail,
      instance: '/api/v1/invitations',
      code,
      correlationId: 'c-test',
      errors: [],
      violations: [],
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

interface Routes {
  preview?: () => Response;
  accept?: () => Response;
  switchTenant?: () => Response;
}

function mockApi(routes: Routes = {}) {
  const fetchMock = vi.fn<typeof fetch>((input) => {
    const url = requestUrl(input);
    if (url === '/api/v1/invitations/preview') {
      return Promise.resolve((routes.preview ?? (() => jsonResponse({ data: PREVIEW })))());
    }
    if (url === '/api/v1/invitations/accept') {
      return Promise.resolve(
        (
          routes.accept ??
          (() =>
            jsonResponse({ data: { id: MEMBERSHIP_ID, tenant: PREVIEW.tenant, status: 'ACTIVE' } }))
        )(),
      );
    }
    if (url === '/api/auth/switch-tenant') {
      return Promise.resolve(
        (
          routes.switchTenant ??
          (() =>
            jsonResponse({
              data: { activeTenant: { id: PREVIEW.tenant.id, name: PREVIEW.tenant.name } },
            }))
        )(),
      );
    }
    return Promise.resolve(problemResponse(500, 'INTERNAL_ERROR', 'x'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const bodyOf = (init?: RequestInit): unknown =>
  JSON.parse(typeof init?.body === 'string' ? init.body : '{}');

function renderCard(props: Partial<Parameters<typeof InvitationAcceptCard>[0]> = {}) {
  const navigate = vi.fn();
  render(
    <IntlProvider>
      <InvitationAcceptCard token={TOKEN} currentTenantId={null} navigate={navigate} {...props} />
    </IntlProvider>,
  );
  return { navigate };
}

afterEach(() => {
  vi.unstubAllGlobals();
  replace.mockReset();
  refresh.mockReset();
});

describe('SCR-102 · aceite do convite (US-091)', () => {
  it('[Válido] mostra instituição, tipo, cargo, lotação e validade; sem violações de a11y', async () => {
    const api = mockApi();
    renderCard();

    expect(await screen.findByText('Prefeitura B')).toBeTruthy();
    expect(screen.getByText('Externo')).toBeTruthy();
    expect(screen.getByText('Fiscal de contrato')).toBeTruthy();
    expect(screen.getByText('Secretaria de Obras, Protocolo')).toBeTruthy();
    expect(screen.getByText('Vínculo válido até')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Aceitar convite' })).toBeTruthy();
    const preview = api.mock.calls.find(([input]) => requestUrl(input).endsWith('/preview'));
    expect(bodyOf(preview?.[1])).toEqual({ token: TOKEN });
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('[Carregando] mostra o estado de carregamento até a resposta', async () => {
    vi.stubGlobal('fetch', () => new Promise<Response>(() => undefined));
    renderCard();
    expect((await screen.findByRole('status')).textContent).toContain('Carregando o convite');
    expect(screen.queryByRole('button', { name: 'Aceitar convite' })).toBeNull();
  });

  it('[Expirado] 410 INVITATION_EXPIRED mostra a orientação e não oferece aceite', async () => {
    mockApi({ preview: () => problemResponse(410, 'INVITATION_EXPIRED', 'Convite expirado.') });
    renderCard();
    expect(await screen.findByText('Este convite expirou. Peça para reenviarem.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Aceitar convite' })).toBeNull();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('[Inválido] 404 INVITATION_INVALID mostra a mensagem e o link para a página de entrada', async () => {
    mockApi({ preview: () => problemResponse(404, 'INVITATION_INVALID', 'Convite inválido.') });
    renderCard();
    expect(await screen.findByText('Este convite não é válido.')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Ir para a página de entrada' }).getAttribute('href'),
    ).toBe('/entrar');
  });

  it('[Inválido] token malformado não chama a API', async () => {
    const api = mockApi();
    renderCard({ token: 'curto' });
    expect(await screen.findByText('Este convite não é válido.')).toBeTruthy();
    expect(api).not.toHaveBeenCalled();
  });

  it('[Erro] falha genérica oferece "Tentar novamente" que recarrega o convite', async () => {
    let calls = 0;
    mockApi({
      preview: () => {
        calls += 1;
        return calls === 1
          ? problemResponse(500, 'INTERNAL_ERROR', 'x')
          : jsonResponse({ data: PREVIEW });
      },
    });
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('Prefeitura B')).toBeTruthy();
  });

  it('[Aceite] USR-06, troca a instituição ativa e segue para o início', async () => {
    const api = mockApi();
    const user = userEvent.setup();
    renderCard({ currentTenantId: '0192a000-0000-7000-8000-00000000000a' });
    await user.click(await screen.findByRole('button', { name: 'Aceitar convite' }));

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/exemplo');
    });
    const accept = api.mock.calls.find(
      ([input]) => requestUrl(input) === '/api/v1/invitations/accept',
    );
    expect(bodyOf(accept?.[1])).toEqual({ token: TOKEN });
    const swap = api.mock.calls.find(([input]) => requestUrl(input) === '/api/auth/switch-tenant');
    expect(bodyOf(swap?.[1])).toEqual({ membershipId: MEMBERSHIP_ID });
    expect(refresh).toHaveBeenCalled();
  });

  it('[Aceite] botão em carregamento durante o aceite (sem duplo envio)', async () => {
    let release: (response: Response) => void = () => undefined;
    const api = mockApi({
      accept: () => {
        throw new Error('substituído abaixo');
      },
    });
    api.mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.endsWith('/preview')) return Promise.resolve(jsonResponse({ data: PREVIEW }));
      if (url.endsWith('/accept')) {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return Promise.resolve(jsonResponse({ data: { activeTenant: { id: PREVIEW.tenant.id } } }));
    });
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Aceitar convite' }));
    const busy = await screen.findByRole('button', { name: 'Aceitando…' });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    release(
      jsonResponse({ data: { id: MEMBERSHIP_ID, tenant: PREVIEW.tenant, status: 'ACTIVE' } }),
    );
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/exemplo');
    });
  });

  it('[Aceite] exige MFA na troca: navega ao step-up em vez de ir ao início', async () => {
    mockApi({
      switchTenant: () =>
        new Response(
          JSON.stringify({
            type: 'https://docs.contrataflow.com.br/errors/mfa-required',
            title: 'MFA_REQUIRED',
            status: 403,
            detail: 'MFA',
            instance: '/api/auth/switch-tenant',
            code: 'MFA_REQUIRED',
            correlationId: 'c',
            errors: [],
            violations: [],
            stepUpUrl: '/api/auth/step-up?returnTo=%2Fexemplo',
          }),
          { status: 403, headers: { 'Content-Type': 'application/problem+json' } },
        ),
    });
    const user = userEvent.setup();
    const { navigate } = renderCard();
    await user.click(await screen.findByRole('button', { name: 'Aceitar convite' }));
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('/api/auth/step-up?returnTo=%2Fexemplo');
    });
    expect(replace).not.toHaveBeenCalled();
  });

  it('[Aceite] convite expirado entre a pré-visualização e o aceite troca para o estado "expirado"', async () => {
    mockApi({ accept: () => problemResponse(410, 'INVITATION_EXPIRED', 'Convite expirado.') });
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Aceitar convite' }));
    expect(await screen.findByText('Este convite expirou. Peça para reenviarem.')).toBeTruthy();
  });

  it('[Aceite] instituição suspensa e indisponibilidade mantêm o botão e avisam', async () => {
    mockApi({ accept: () => problemResponse(403, 'TENANT_SUSPENDED', 'Suspensa.') });
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Aceitar convite' }));
    expect(
      await screen.findByText('Esta instituição está suspensa e não aceita novos vínculos agora.'),
    ).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Aceitar convite' }).disabled,
    ).toBe(false);
  });

  it('[Sessão] 401 na pré-visualização leva ao login com retorno ao convite', async () => {
    mockApi({ preview: () => problemResponse(401, 'UNAUTHENTICATED', 'Sem sessão.') });
    const { navigate } = renderCard();
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith(
        `/api/auth/login?returnTo=${encodeURIComponent(`/convite/${TOKEN}`)}`,
      );
    });
  });
});
