// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import GlobalError from '@/app/global-error';
import { ApiError } from '@/lib/api/api-error';
import { seriousA11yViolations } from '@test/support/axe';
import { IntlProvider, jsonResponse, requestUrl, shellSession } from '@test/support/render';

import { ConflictDialog } from './conflict-dialog';
import { CorrelationCode } from './correlation-code';
import { SegmentError } from './segment-error';
import { AppProviders } from '../shell/app-providers';

const router = { refresh: vi.fn() };

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/exemplo',
}));

afterEach(() => {
  vi.unstubAllGlobals();
  router.refresh.mockClear();
});

function renderSegment(error: Error, retry = vi.fn()) {
  render(
    <IntlProvider>
      <QueryClientProvider client={new QueryClient()}>
        <SegmentError error={error} retry={retry} />
      </QueryClientProvider>
    </IntlProvider>,
  );
  return retry;
}

describe('[Falha de banco] API indisponível exibe o error.tsx padrão', () => {
  it('503 DEPENDENCY_UNAVAILABLE: correlationId copiável e "Tentar novamente"', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const retry = renderSegment(
      new ApiError({ status: 503, code: 'DEPENDENCY_UNAVAILABLE', correlationId: 'c-503-abc' }),
    );
    const heading = screen.getByRole('heading', {
      level: 2,
      name: 'Serviço temporariamente indisponível',
    });
    expect(document.activeElement).toBe(heading);
    expect(screen.getByText('Código: c-503-abc')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Copiar código' }));
    expect(writeText).toHaveBeenCalledWith('c-503-abc');
    expect(await screen.findByText('Código copiado.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('erro sem ApiError (falha não tratada) não exibe código técnico', () => {
    renderSegment(Object.assign(new Error('stack interna'), { digest: '123' }));
    expect(screen.getByRole('heading', { name: 'Ocorreu um erro inesperado' })).toBeTruthy();
    expect(screen.queryByText(/Código/)).toBeNull();
    expect(screen.queryByText(/stack interna/)).toBeNull();
  });

  it('404 tem a mensagem única (inexistente ou sem acesso)', () => {
    renderSegment(new ApiError({ status: 404, code: 'NOT_FOUND', correlationId: 'c' }));
    expect(
      screen.getByRole('heading', { name: 'Página não encontrada ou sem acesso' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Tentar novamente' })).toBeNull();
  });

  it('cópia indisponível não quebra a tela', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: () => Promise.reject(new Error('negado')) },
    });
    render(
      <CorrelationCode
        correlationId="c-1"
        labels={{ code: 'Código: c-1', copy: 'Copiar', copied: 'Copiado' }}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Copiar' }));
    expect(screen.queryByText('Copiado')).toBeNull();
  });

  it('global-error é a última barreira, em pt-BR', () => {
    const html = renderToStaticMarkup(
      <GlobalError
        error={new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c-g' })}
        retry={vi.fn()}
      />,
    );
    expect(html).toContain('<html lang="pt-BR">');
    expect(html).toContain('Ocorreu um erro inesperado</h1>');
    expect(html).toContain('Código: c-g');
    expect(html).toContain('Tentar novamente');
    const plain = renderToStaticMarkup(<GlobalError error={new Error('x')} retry={vi.fn()} />);
    expect(plain).not.toContain('Código');
  });
});

describe('FA-05 — diálogo de conflito padrão (412)', () => {
  it('recarregar, ver diferenças e cancelar', async () => {
    const onReload = vi.fn();
    const onShowDiff = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <IntlProvider>
        <ConflictDialog
          open
          onOpenChange={onOpenChange}
          onReload={onReload}
          onShowDiff={onShowDiff}
        />
      </IntlProvider>,
    );
    const dialog = screen.getByRole('dialog', {
      name: 'Este registro foi alterado por outra pessoa.',
    });
    expect(dialog).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Ver diferenças' }));
    await userEvent.click(screen.getByRole('button', { name: 'Recarregar' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onShowDiff).toHaveBeenCalled();
    expect(onReload).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('mutação com 412 abre o diálogo pelo shell; recarregar refaz os dados', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(() =>
        Promise.resolve(jsonResponse({ code: 'VERSION_CONFLICT' }, { status: 412 })),
      ),
    );
    const { useMutation } = await import('@tanstack/react-query');
    const { apiRequest } = await import('@/lib/api/client');
    function Editor() {
      const mutation = useMutation({
        mutationFn: () => apiRequest('/processes/1', { method: 'PATCH', body: {}, ifMatch: '"1"' }),
      });
      return (
        <button
          type="button"
          onClick={() => {
            mutation.mutate();
          }}
        >
          Salvar
        </button>
      );
    }
    render(
      <IntlProvider>
        <AppProviders session={shellSession()}>
          <Editor />
        </AppProviders>
      </IntlProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await screen.findByRole('dialog', { name: 'Este registro foi alterado por outra pessoa.' });
    await userEvent.click(screen.getByRole('button', { name: 'Recarregar' }));
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('429 em mutação vira aviso com o tempo de espera', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>((input, init) =>
        Promise.resolve(
          // O shell lê ME-03 (US-097) e o perfil (US-098) ao montar; só a mutação é limitada.
          requestUrl(input).startsWith('/api/v1/me/permissions')
            ? jsonResponse({ data: { permissions: [], implicit: { headOfDepartmentIds: [] } } })
            : init?.method === 'POST'
              ? jsonResponse(
                  { code: 'RATE_LIMITED' },
                  { status: 429, headers: { 'Retry-After': '12' } },
                )
              : jsonResponse({ data: {} }),
        ),
      ),
    );
    const { useMutation } = await import('@tanstack/react-query');
    const { apiRequest } = await import('@/lib/api/client');
    function Sender() {
      const mutation = useMutation({
        mutationFn: () => apiRequest('/x', { method: 'POST', body: {} }),
      });
      return (
        <button
          type="button"
          onClick={() => {
            mutation.mutate();
          }}
        >
          Enviar
        </button>
      );
    }
    render(
      <IntlProvider>
        <AppProviders session={shellSession()}>
          <Sender />
        </AppProviders>
      </IntlProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(await screen.findByText('Muitas tentativas. Aguarde 12 segundos.')).toBeTruthy();
  });
});
