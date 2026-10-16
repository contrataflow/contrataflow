// @vitest-environment jsdom
import type { ActionEntry, MyPermissionsDto } from '@contrataflow/validation';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeQueryClient } from '@/lib/query/query-client';
import { ShellSessionProvider } from '@/lib/session/session-context';
import {
  IntlProvider,
  TENANT_B,
  jsonResponse,
  problem,
  renderWithShell,
  requestUrl,
  shellSession,
} from '@test/support/render';

import { Can, Gate } from './can';
import {
  PermissionProvider,
  hasPermission,
  scopesOf,
  useEffectivePermissions,
  usePermission,
} from './use-permission';
import { processCapabilities, useProcessCapabilities } from './use-process-capabilities';

/*
 * US-097 — hooks de permissão do frontend (RN-IAM-106/107): ME-03 é a única fonte; enquanto carrega
 * ou em erro, o protegido fica OCULTO (nunca habilitado por engano); ações contextuais vêm de PRC-08.
 */

const PROCESS = '0192a000-0000-7000-8000-00000000c0de';

const ME: MyPermissionsDto = {
  permissions: [
    { code: 'PROCESS_CREATE', scopes: [{ type: 'OWN_DEPARTMENTS', includeSubtree: true }] },
    {
      code: 'PROCESS_VIEW',
      scopes: [
        { type: 'OWN_DEPARTMENTS', includeSubtree: true },
        { type: 'ORGANIZATION', organizationId: TENANT_B.id, includeSubtree: false },
      ],
    },
  ],
  implicit: { headOfDepartmentIds: [] },
};

function mockApi(handler: (url: string) => Response | Promise<Response>) {
  const fetchMock = vi.fn<typeof fetch>((input) => Promise.resolve(handler(requestUrl(input))));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('funções puras', () => {
  it('hasPermission/scopesOf: em algum escopo; sem resposta, nada', () => {
    expect(hasPermission(ME, 'PROCESS_CREATE')).toBe(true);
    expect(hasPermission(ME, 'PROCESS_CANCEL')).toBe(false);
    expect(hasPermission(undefined, 'PROCESS_CREATE')).toBe(false);
    expect(scopesOf(ME, 'PROCESS_VIEW')).toHaveLength(2);
    expect(scopesOf(ME, 'AUDIT_VIEW')).toEqual([]);
  });

  it('processCapabilities: só com sucesso; motivos apenas da ação indisponível', () => {
    const entries: ActionEntry[] = [
      {
        action: 'FORWARD',
        label: 'Encaminhar',
        enabled: false,
        reasons: [{ code: 'X', message: 'Há 2 pendências' }],
      },
      { action: 'CLAIM', label: 'Assumir', enabled: true, reasons: [] },
    ];
    const ready = processCapabilities(entries, 'success');
    expect(ready.offers('FORWARD')).toBe(true);
    expect(ready.can('FORWARD')).toBe(false);
    expect(ready.reasonsOf('FORWARD')).toEqual([{ code: 'X', message: 'Há 2 pendências' }]);
    expect(ready.can('CLAIM')).toBe(true);
    expect(ready.reasonsOf('CLAIM')).toEqual([]);
    expect(ready.offers('CANCEL')).toBe(false);
    const loading = processCapabilities(entries, 'pending');
    expect(loading.entries).toEqual([]);
    expect(loading.can('CLAIM')).toBe(false);
  });
});

describe('PermissionProvider + usePermission (ME-03)', () => {
  it('oculto enquanto ME-03 carrega; visível com a permissão; uma única chamada para a tela toda', async () => {
    let release: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchMock = mockApi((url) =>
      url.startsWith('/api/v1/me/permissions') ? pending : jsonResponse({}),
    );
    renderWithShell(
      <PermissionProvider>
        <Gate permission="PROCESS_CREATE" fallback={<p>sem acesso</p>}>
          <button type="button">Novo processo</button>
        </Gate>
        <Can permission="PROCESS_VIEW">
          <a href="/processos">Processos</a>
        </Can>
        <Gate permission="PROCESS_CANCEL">
          <button type="button">Cancelar</button>
        </Gate>
      </PermissionProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Novo processo' })).toBeNull();
    expect(screen.getByText('sem acesso')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Processos' })).toBeNull();

    await act(async () => {
      release(jsonResponse({ data: ME }));
      await pending;
    });
    await screen.findByRole('button', { name: 'Novo processo' });
    expect(screen.getByRole('link', { name: 'Processos' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancelar' })).toBeNull();
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        requestUrl(input).startsWith('/api/v1/me/permissions'),
      ),
    ).toHaveLength(1);
  });

  it('ME-03 em erro: tudo protegido continua oculto (a API decide)', async () => {
    mockApi(() => problem(403, 'MEMBERSHIP_INACTIVE'));
    const { result } = renderHook(() => usePermission('PROCESS_CREATE'), {
      wrapper: ({ children }: { readonly children: ReactNode }) => (
        <IntlProvider>
          <QueryClientProvider client={makeQueryClient()}>
            <ShellSessionProvider session={shellSession()}>
              <PermissionProvider>{children}</PermissionProvider>
            </ShellSessionProvider>
          </QueryClientProvider>
        </IntlProvider>
      ),
    });
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.allowed).toBe(false);
  });

  it('fora do provider, os hooks consultam ME-03 diretamente (mesmo cache)', async () => {
    mockApi(() => jsonResponse({ data: ME }));
    const queryClient = makeQueryClient();
    const { result } = renderHook(() => useEffectivePermissions(), {
      wrapper: ({ children }: { readonly children: ReactNode }) => (
        <IntlProvider>
          <QueryClientProvider client={queryClient}>
            <ShellSessionProvider session={shellSession()}>{children}</ShellSessionProvider>
          </QueryClientProvider>
        </IntlProvider>
      ),
    });
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.data?.permissions).toHaveLength(2);
  });

  it('o elemento some quando o perfil muda (nova leitura de ME-03 após a troca)', async () => {
    let current: MyPermissionsDto = ME;
    mockApi((url) =>
      url.startsWith('/api/v1/me/permissions') ? jsonResponse({ data: current }) : jsonResponse({}),
    );
    const { queryClient } = renderWithShell(
      <PermissionProvider>
        <Gate permission="PROCESS_CREATE">
          <button type="button">Novo processo</button>
        </Gate>
      </PermissionProvider>,
    );
    await screen.findByRole('button', { name: 'Novo processo' });
    current = { permissions: [], implicit: { headOfDepartmentIds: [] } };
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Novo processo' })).toBeNull();
    });
  });
});

describe('useProcessCapabilities (PRC-08)', () => {
  it('ações e motivos vêm da API; carregando, nada é permitido', async () => {
    const entries: ActionEntry[] = [
      {
        action: 'FORWARD',
        label: 'Encaminhar',
        enabled: false,
        reasons: [{ code: 'TRANSITION_BLOCKED', message: 'Há 2 pendências na etapa' }],
      },
    ];
    mockApi((url) =>
      url === `/api/v1/processes/${PROCESS}/available-actions`
        ? jsonResponse({ data: entries })
        : jsonResponse({}),
    );
    const { result } = renderHook(() => useProcessCapabilities(PROCESS), {
      wrapper: ({ children }: { readonly children: ReactNode }) => (
        <IntlProvider>
          <QueryClientProvider client={makeQueryClient()}>
            <ShellSessionProvider session={shellSession()}>{children}</ShellSessionProvider>
          </QueryClientProvider>
        </IntlProvider>
      ),
    });
    expect(result.current.can('FORWARD')).toBe(false);
    expect(result.current.offers('FORWARD')).toBe(false);
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.offers('FORWARD')).toBe(true);
    expect(result.current.can('FORWARD')).toBe(false);
    expect(result.current.reasonsOf('FORWARD')[0]?.message).toBe('Há 2 pendências na etapa');
  });
});

describe('<Can> desabilitado com explicação (a11y)', () => {
  it('mantém aria-disabled e o motivo ligado por aria-describedby', async () => {
    mockApi(() => jsonResponse({ data: ME }));
    renderWithShell(
      <PermissionProvider>
        <Can
          permission="PROCESS_VIEW"
          action="forward"
          allowedActions={[]}
          unavailableReason="Encaminhar — há 2 pendências na etapa"
        >
          <button type="button">Encaminhar</button>
        </Can>
      </PermissionProvider>,
    );
    const reason = await screen.findByText('Encaminhar — há 2 pendências na etapa');
    const group = reason.previousElementSibling;
    expect(group?.getAttribute('aria-disabled')).toBe('true');
    expect(group?.getAttribute('aria-describedby')).toBe(reason.id);
  });
});
