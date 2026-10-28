// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { IntlProvider, jsonResponse, problem } from '@test/support/render';

import { LoginForm } from './login-form';

/*
 * SCR-001 — formulário de entrada nativo (DEC-187): estados de erro, etapa de código, foco e
 * acessibilidade. O BFF é simulado no `fetch` (a rota tem testes próprios).
 */

const assign = vi.fn();
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  assign.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('location', { href: 'http://localhost:3000/entrar', assign });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderForm(props: Partial<Parameters<typeof LoginForm>[0]> = {}) {
  return render(
    <IntlProvider>
      <LoginForm
        returnTo="/processos"
        reason={null}
        forgotHref="/api/auth/forgot-password"
        {...props}
      />
    </IntlProvider>,
  );
}

async function fillAndSubmit(username = 'requisitante.a', password = 'segredo') {
  await userEvent.type(screen.getByLabelText('Usuário ou e-mail'), username);
  await userEvent.type(screen.getByLabelText('Senha'), password);
  await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));
}

function sentBody(call = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[call]?.[1];
  const body = typeof init?.body === 'string' ? init.body : '{}';
  return JSON.parse(body) as Record<string, unknown>;
}

/** Resposta da etapa de código (nova a cada uso: o corpo só pode ser lido uma vez). */
const mfa = () =>
  jsonResponse({ data: { step: 'mfa', transaction: 'T'.repeat(43), methods: ['totp'] } });

describe('SCR-001 — formulário de entrada nativo (DEC-187)', () => {
  it('[Sucesso] envia usuário e senha ao BFF com o cabeçalho de CSRF e navega ao destino', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { step: 'done', redirectTo: '/processos' } }),
    );
    renderForm();
    expect(document.activeElement).toBe(screen.getByLabelText('Usuário ou e-mail'));
    await fillAndSubmit('  requisitante.a  ');
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('/processos');
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/auth/login');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('X-CF-Request')).toBe('1');
    expect(sentBody()).toEqual({
      username: 'requisitante.a',
      password: 'segredo',
      returnTo: '/processos',
    });
  });

  it('[Validação] campos vazios: mensagem no campo, foco no primeiro e nada vai ao BFF', async () => {
    renderForm({ returnTo: null });
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    const username = screen.getByLabelText('Usuário ou e-mail');
    expect(username.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Informe o usuário ou e-mail.')).toBeTruthy();
    expect(screen.getByText('Informe a senha.')).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).toBe(username);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('[Validação] 422 do BFF marca os campos recusados', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          code: 'VALIDATION_ERROR',
          errors: [{ field: 'password', code: 'TOO_LONG', message: 'Informe a senha.' }],
        },
        { status: 422 },
      ),
    );
    renderForm();
    await fillAndSubmit();
    await waitFor(() => {
      expect(screen.getByLabelText('Senha').getAttribute('aria-invalid')).toBe('true');
    });
    expect(screen.getByLabelText('Usuário ou e-mail').getAttribute('aria-invalid')).toBeNull();
  });

  it('[Validação] credencial inválida: alerta genérico, senha apagada e foco nela', async () => {
    fetchMock.mockResolvedValueOnce(problem(401, 'INVALID_CREDENTIALS'));
    renderForm({ reason: 'saiu' });
    expect(screen.getByRole('status').textContent).toBe('Você saiu com segurança.');
    await fillAndSubmit();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'Usuário ou senha inválidos. Confira os dados e tente de novo. Após 5 tentativas, o acesso é bloqueado temporariamente.',
    );
    // O aviso do motivo dá lugar ao erro.
    expect(screen.queryByRole('status')).toBeNull();
    const password = screen.getByLabelText('Senha');
    expect((password as HTMLInputElement).value).toBe('');
    await waitFor(() => {
      expect(document.activeElement).toBe(password);
    });
    expect(screen.getByLabelText<HTMLInputElement>('Usuário ou e-mail').value).toBe(
      'requisitante.a',
    );
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it.each([
    [
      problem(403, 'LOCKED'),
      'Acesso bloqueado temporariamente após tentativas inválidas. Tente mais tarde ou use “Esqueci minha senha”.',
    ],
    [problem(429, 'RATE_LIMITED'), 'Muitas tentativas. Aguarde alguns instantes e tente de novo.'],
    [
      problem(503, 'IDP_UNAVAILABLE'),
      'O serviço de autenticação está indisponível. Tente novamente em instantes.',
    ],
    [
      problem(503, 'DEPENDENCY_UNAVAILABLE'),
      'O serviço de autenticação está indisponível. Tente novamente em instantes.',
    ],
    [
      problem(403, 'CSRF_REJECTED'),
      'Não foi possível confirmar a origem da solicitação. Recarregue a página.',
    ],
    [problem(500, 'INTERNAL_ERROR'), 'Não foi possível concluir a entrada. Tente novamente.'],
    [
      new Response('<html>', { status: 502 }),
      'Não foi possível concluir a entrada. Tente novamente.',
    ],
  ])('[Falha] resposta %#: mensagem própria, sem navegar', async (response, message) => {
    fetchMock.mockResolvedValueOnce(response);
    renderForm();
    await fillAndSubmit();
    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Entrar' }).hasAttribute('disabled')).toBe(false);
  });

  it('[Falha de integração] rede fora: "indisponível"', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderForm();
    await fillAndSubmit();
    expect((await screen.findByRole('alert')).textContent).toBe(
      'O serviço de autenticação está indisponível. Tente novamente em instantes.',
    );
  });

  it('[Duplicidade] enquanto envia: botão desabilitado com "Entrando…" e um único envio', async () => {
    let release: (response: Response) => void = () => undefined;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    renderForm();
    await fillAndSubmit();
    const busy = screen.getByRole('button', { name: 'Entrando…' });
    expect(busy.hasAttribute('disabled')).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    release(jsonResponse({ data: { step: 'done', redirectTo: '/painel' } }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('/painel');
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('[Validação] destino fora da aplicação nunca é seguido', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { step: 'done', redirectTo: '//evil.com/x' } }),
    );
    renderForm();
    await fillAndSubmit();
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('/painel');
    });
  });

  it('mostrar/ocultar senha troca o tipo do campo e o rótulo do botão', async () => {
    renderForm();
    const password = screen.getByLabelText('Senha');
    expect(password.getAttribute('type')).toBe('password');
    await userEvent.click(screen.getByRole('button', { name: 'Mostrar senha' }));
    expect(password.getAttribute('type')).toBe('text');
    await userEvent.click(screen.getByRole('button', { name: 'Ocultar senha' }));
    expect(password.getAttribute('type')).toBe('password');
  });

  it('[Sucesso] MFA: etapa de código de 6 dígitos, código errado e depois o certo', async () => {
    fetchMock
      .mockResolvedValueOnce(mfa())
      .mockResolvedValueOnce(problem(401, 'MFA_INVALID'))
      .mockResolvedValueOnce(jsonResponse({ data: { step: 'done', redirectTo: '/processos' } }));
    renderForm();
    await fillAndSubmit();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Confirme sua identidade' }),
    ).toBeTruthy();
    const code = screen.getByLabelText('Código de verificação');
    await waitFor(() => {
      expect(document.activeElement).toBe(code);
    });
    expect(code.getAttribute('autocomplete')).toBe('one-time-code');
    expect(code.getAttribute('inputmode')).toBe('numeric');
    expect(await seriousA11yViolations()).toEqual([]);

    // Só dígitos, no máximo 6; menos de 6 não vai ao BFF.
    await userEvent.type(code, '12a3');
    expect((code as HTMLInputElement).value).toBe('123');
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar e entrar' }));
    expect(screen.getByText('Informe o código de 6 dígitos.')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await userEvent.type(code, '4567');
    expect((code as HTMLInputElement).value).toBe('123456');
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar e entrar' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Código inválido. Confira o aplicativo autenticador e tente de novo.',
    );
    expect((code as HTMLInputElement).value).toBe('');
    expect(sentBody(1)).toEqual({ transaction: 'T'.repeat(43), code: '123456' });

    await userEvent.type(code, '654321');
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar e entrar' }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('/processos');
    });
  });

  it('MFA expirado (5 min ou códigos demais): volta à senha com o aviso', async () => {
    fetchMock.mockResolvedValueOnce(mfa()).mockResolvedValueOnce(problem(401, 'MFA_EXPIRED'));
    renderForm();
    await fillAndSubmit();
    const code = await screen.findByLabelText('Código de verificação');
    await userEvent.type(code, '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar e entrar' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'A verificação expirou. Informe usuário e senha novamente.',
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Entrar' })).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Senha'));
    });
  });

  it('"Voltar" na etapa de código retorna ao usuário e senha', async () => {
    fetchMock.mockResolvedValueOnce(mfa());
    renderForm();
    await fillAndSubmit();
    await userEvent.click(await screen.findByRole('button', { name: 'Voltar' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Entrar' })).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Usuário ou e-mail').value).toBe(
      'requisitante.a',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Senha').value).toBe('');
  });
});
