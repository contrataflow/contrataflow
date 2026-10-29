// @vitest-environment jsdom
import { configure, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { AdminHub } from './admin-hub';
import { AdminNav } from './main-nav';

// A suíte completa roda em paralelo com as demais; o padrão de 1 s é curto para a primeira renderização.
configure({ asyncUtilTimeout: 5000 });

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => '/admin',
}));

function mockPermissions(codes: readonly string[]) {
  const fetchMock = vi.fn<typeof fetch>((input) =>
    Promise.resolve(
      requestUrl(input).startsWith('/api/v1/me/permissions')
        ? jsonResponse({
            data: { permissions: codes.map((code) => ({ code, scopes: ['TENANT'] })) },
          })
        : jsonResponse({ code: 'NOT_FOUND' }, { status: 404 }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hub da administração (prd-5 · card 8)', () => {
  it('agrupa as áreas em cartões com uma frase e o link, sem violações de acessibilidade', async () => {
    const api = mockPermissions([
      'ROLE_VIEW',
      'TEMPLATE_VIEW',
      'WORKFLOW_VIEW',
      'DOCUMENT_TYPE_MANAGE',
    ]);
    renderWithShell(<AdminHub />);
    await waitFor(() => {
      expect(api).toHaveBeenCalled();
    });

    expect(screen.getByRole('heading', { level: 1, name: 'Administração' })).toBeTruthy();
    const people = screen.getByRole('region', { name: 'Pessoas e acesso' });
    expect(
      within(people)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual(['/admin/usuarios', '/admin/perfis']);
    expect(within(people).getByRole('link', { name: /Usuários.*Convide pessoas/ })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Estrutura' })).toBeTruthy();
    expect(
      within(screen.getByRole('region', { name: 'Documentos e fluxos' })).getAllByRole('link'),
    ).toHaveLength(4);
    expect(
      within(screen.getByRole('region', { name: 'Sistema' })).getByRole('link', {
        name: /Configurações/,
      }),
    ).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('[Permissão] some o cartão da área quando a API confirma que falta a permissão', async () => {
    mockPermissions(['PROCESS_VIEW']);
    renderWithShell(<AdminHub />);
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: /Perfis e permissões/ })).toBeNull();
    });
    expect(screen.queryByRole('link', { name: /Tipos de documento/ })).toBeNull();
    expect(screen.getByRole('link', { name: /Usuários/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Calendário/ })).toBeTruthy();
  });

  it('a barra de navegação de administração não se repete no hub', () => {
    mockPermissions([]);
    renderWithShell(<AdminNav />);
    expect(screen.queryByRole('navigation', { name: 'Navegação de administração' })).toBeNull();
  });
});
