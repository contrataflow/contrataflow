// @vitest-environment jsdom
import type { TenantMembershipDto } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { StatusBadge } from './status-badge';
import { UserList } from './user-list';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

const COMPRAS = '0192a000-0000-7000-8000-0000000000c1';
const LICITACOES = '0192a000-0000-7000-8000-0000000000c2';

let sequence = 0;
function member(overrides: Partial<TenantMembershipDto> = {}): TenantMembershipDto {
  sequence += 1;
  const n = String(sequence).padStart(12, '0');
  return {
    id: `0192a000-0000-7000-8000-${n}`,
    userId: `0192a000-0000-7000-9000-${n}`,
    name: 'Diego Ramos',
    socialName: null,
    email: 'diego@exemplo.gov.br',
    type: 'INTERNAL',
    status: 'ACTIVE',
    jobTitle: 'Analista',
    registrationNumber: null,
    expiresAt: null,
    departmentIds: [COMPRAS],
    primaryDepartmentId: COMPRAS,
    invitedAt: '2026-10-01T12:00:00.000Z',
    inviteExpiresAt: null,
    activatedAt: '2026-10-02T12:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

const DIEGO = member();
const PEDRO = member({
  name: 'Pedro Alves',
  email: 'pedro@fornecedor.com.br',
  type: 'EXTERNAL',
  jobTitle: null,
  expiresAt: '2020-01-01T23:59:59.000Z',
  primaryDepartmentId: LICITACOES,
});

function problemResponse(status: number, code: string): Response {
  return new Response(
    JSON.stringify({
      type: `https://docs.contrataflow.com.br/errors/${code.toLowerCase()}`,
      title: code,
      status,
      detail: 'x',
      instance: '/api/v1/users',
      code,
      correlationId: 'c-test',
      errors: [],
      violations: [],
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

type Handler = (url: string) => Response | Promise<Response>;

function mockApi(list?: Handler, permissions: readonly string[] = ['USER_VIEW']) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/v1/me/permissions')) {
      return Promise.resolve(
        jsonResponse({ data: { permissions: permissions.map((code) => ({ code, scopes: [] })) } }),
      );
    }
    if (method === 'GET' && url.startsWith('/api/v1/departments/lookup')) {
      return Promise.resolve(
        jsonResponse({
          data: [
            { id: COMPRAS, name: 'Setor de Compras', type: 'SECTOR', path: 'Setor de Compras' },
            {
              id: LICITACOES,
              name: 'Setor de Licitações',
              type: 'SECTOR',
              path: 'Setor de Licitações',
            },
          ],
        }),
      );
    }
    if (method === 'GET' && url.startsWith('/api/v1/users?')) {
      return Promise.resolve(
        (
          list ??
          (() =>
            jsonResponse({
              data: [DIEGO, PEDRO],
              meta: { page: 1, pageSize: 20, totalItems: 2, totalPages: 1 },
            }))
        )(url),
      );
    }
    return Promise.resolve(problemResponse(500, 'INTERNAL_ERROR'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const usersCalls = (api: ReturnType<typeof mockApi>) =>
  api.mock.calls
    .map(([input]) => requestUrl(input))
    .filter((url) => url.startsWith('/api/v1/users?'))
    .map((url) => new URL(url, 'http://localhost').searchParams);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StatusBadge (RN-IAM-64)', () => {
  it('vínculo externo vencido aparece como "Expirado" antes do job; interno ativo segue "Ativo"', () => {
    const expired = renderWithShell(<StatusBadge membership={PEDRO} />);
    expect(screen.getByText('Expirado')).toBeTruthy();
    expired.unmount();
    renderWithShell(
      <StatusBadge membership={{ ...PEDRO, expiresAt: '2999-01-01T00:00:00.000Z' }} />,
    );
    expect(screen.queryByText('Expirado')).toBeNull();
  });
});

describe('SCR-029 · lista de usuários (US-092)', () => {
  it('lista os vínculos com link para o detalhe, lotação principal e "Expirado"; sem violações de a11y', async () => {
    const api = mockApi();
    renderWithShell(<UserList />);

    const table = await screen.findByRole('table', { name: 'Usuários da instituição' });
    const diego = within(table).getByRole('row', { name: /Diego Ramos/ });
    expect(within(diego).getByRole('link', { name: 'Diego Ramos' }).getAttribute('href')).toBe(
      `/admin/usuarios/${DIEGO.userId}`,
    );
    expect(within(diego).getByText('Analista')).toBeTruthy();
    expect(within(diego).getByText('Interno')).toBeTruthy();
    expect(within(diego).getByText('Ativo')).toBeTruthy();
    await waitFor(() => {
      expect(within(diego).getByText('Setor de Compras')).toBeTruthy();
    });
    const pedro = within(table).getByRole('row', { name: /Pedro Alves/ });
    expect(within(pedro).getByText('Expirado')).toBeTruthy();
    expect(within(pedro).getByText('Externo')).toBeTruthy();

    // Padrão: todos os status, menos os convites (que têm a própria seção).
    const first = usersCalls(api)[0];
    expect(first?.get('status')).toBe('ACTIVE,SUSPENDED,REVOKED,EXPIRED');
    expect(first?.get('page')).toBe('1');
    expect(first?.has('q')).toBe(false);
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('busca (≥ 2 caracteres, com debounce) e filtros por status, tipo e lotação voltam à página 1', async () => {
    const api = mockApi();
    const user = userEvent.setup();
    renderWithShell(<UserList />);
    await screen.findByRole('table');

    const search = screen.getByRole('searchbox', { name: 'Buscar por nome ou e-mail' });
    await user.type(search, 'd');
    // Um caractere não vai à API.
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(usersCalls(api).every((params) => !params.has('q'))).toBe(true);

    await user.type(search, 'iego');
    await waitFor(() => {
      expect(usersCalls(api).some((params) => params.get('q') === 'diego')).toBe(true);
    });

    await user.selectOptions(screen.getByLabelText('Status'), 'SUSPENDED');
    await waitFor(() => {
      expect(usersCalls(api).some((params) => params.get('status') === 'SUSPENDED')).toBe(true);
    });
    await user.selectOptions(screen.getByLabelText('Tipo de vínculo'), 'EXTERNAL');
    await user.selectOptions(await screen.findByLabelText('Lotação'), LICITACOES);
    await waitFor(() => {
      const last = usersCalls(api).at(-1);
      expect(last?.get('q')).toBe('diego');
      expect(last?.get('status')).toBe('SUSPENDED');
      expect(last?.get('type')).toBe('EXTERNAL');
      expect(last?.get('departmentId')).toBe(LICITACOES);
      expect(last?.get('page')).toBe('1');
    });
  });

  it('pagina e volta à página 1 ao mudar o filtro', async () => {
    const api = mockApi((url) => {
      const page = Number(new URL(url, 'http://localhost').searchParams.get('page'));
      return jsonResponse({
        data: [page === 1 ? DIEGO : PEDRO],
        meta: { page, pageSize: 20, totalItems: 25, totalPages: 2 },
      });
    });
    const user = userEvent.setup();
    renderWithShell(<UserList />);
    await screen.findByText('Página 1 de 2');
    await user.click(screen.getByRole('button', { name: 'Próxima' }));
    await screen.findByText('Página 2 de 2');
    expect(usersCalls(api).at(-1)?.get('page')).toBe('2');

    await user.selectOptions(screen.getByLabelText('Status'), 'ACTIVE');
    await screen.findByText('Página 1 de 2');
    expect(usersCalls(api).at(-1)?.get('page')).toBe('1');
  });

  it('carregando, vazio, erro com "Tentar novamente" e 403', async () => {
    mockApi(() => new Promise<Response>(() => undefined));
    const loading = renderWithShell(<UserList />);
    expect((await screen.findByRole('status')).textContent).toContain('Carregando os usuários');
    loading.unmount();

    mockApi(() =>
      jsonResponse({ data: [], meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 } }),
    );
    const empty = renderWithShell(<UserList />);
    expect(await screen.findByText('Nenhum usuário encontrado')).toBeTruthy();
    empty.unmount();

    let healthy = false;
    mockApi(() =>
      healthy
        ? jsonResponse({
            data: [DIEGO],
            meta: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
          })
        : problemResponse(400, 'MALFORMED_REQUEST'),
    );
    const user = userEvent.setup();
    const failing = renderWithShell(<UserList />);
    expect(await screen.findByText('Não foi possível carregar os usuários.')).toBeTruthy();
    healthy = true;
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('table')).toBeTruthy();
    failing.unmount();

    mockApi(() => problemResponse(403, 'PERMISSION_DENIED'));
    renderWithShell(<UserList />);
    expect(await screen.findByText('Você não tem acesso a esta área')).toBeTruthy();
  });
});
