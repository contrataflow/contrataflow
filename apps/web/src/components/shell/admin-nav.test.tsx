// @vitest-environment jsdom
import { configure, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { AdminNav } from './main-nav';

// A suíte completa roda em paralelo com as demais; o padrão de 1 s é curto para a primeira renderização.
configure({ asyncUtilTimeout: 5000 });

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => '/admin',
}));

function mockPermissions(respond: () => Response) {
  const fetchMock = vi.fn<typeof fetch>((input) => {
    const url = requestUrl(input);
    return Promise.resolve(
      url.startsWith('/api/v1/me/permissions')
        ? respond()
        : jsonResponse({ code: 'NOT_FOUND' }, { status: 404 }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[Permissão] item "Perfis e permissões" da navegação de administração', () => {
  it('aparece para quem tem ROLE_VIEW', async () => {
    const api = mockPermissions(() =>
      jsonResponse({ data: { permissions: [{ code: 'ROLE_VIEW', scopes: [] }] } }),
    );
    renderWithShell(<AdminNav />);
    await waitFor(() => {
      expect(api).toHaveBeenCalled();
    });
    expect(await screen.findByRole('link', { name: 'Perfis e permissões' })).toBeTruthy();
  });

  it('Usuário sem ROLE_VIEW: o item de menu não deve ser exibido', async () => {
    mockPermissions(() =>
      jsonResponse({ data: { permissions: [{ code: 'PROCESS_VIEW', scopes: ['TENANT'] }] } }),
    );
    renderWithShell(<AdminNav />);
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Perfis e permissões' })).toBeNull();
    });
    expect(screen.getByRole('link', { name: 'Usuários' })).toBeTruthy();
  });
});

describe('[Permissão] item "Tipos de documento" da navegação de administração', () => {
  it('aparece para quem tem DOCUMENT_TYPE_MANAGE', async () => {
    const api = mockPermissions(() =>
      jsonResponse({ data: { permissions: [{ code: 'DOCUMENT_TYPE_MANAGE', scopes: [] }] } }),
    );
    renderWithShell(<AdminNav />);
    await waitFor(() => {
      expect(api).toHaveBeenCalled();
    });
    expect(await screen.findByRole('link', { name: 'Tipos de documento' })).toBeTruthy();
  });

  it('some quando a API confirma que o usuário não tem a permissão', async () => {
    mockPermissions(() =>
      jsonResponse({ data: { permissions: [{ code: 'PROCESS_VIEW', scopes: ['TENANT'] }] } }),
    );
    renderWithShell(<AdminNav />);
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Tipos de documento' })).toBeNull();
    });
    // As demais áreas, sem permissão declarada, seguem na navegação.
    expect(screen.getByRole('link', { name: 'Usuários' })).toBeTruthy();
  });

  it('sem resposta de permissões (ME-03 ainda indisponível) o item permanece: a rota decide com o 403', async () => {
    const api = mockPermissions(() => jsonResponse({ code: 'NOT_FOUND' }, { status: 404 }));
    renderWithShell(<AdminNav />);
    await waitFor(() => {
      expect(api).toHaveBeenCalled();
    });
    expect(screen.getByRole('link', { name: 'Tipos de documento' })).toBeTruthy();
  });
});
