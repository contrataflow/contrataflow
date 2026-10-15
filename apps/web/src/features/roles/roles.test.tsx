// @vitest-environment jsdom
import { PERMISSIONS } from '@contrataflow/types';
import { ADMIN_ORGAO_SEEDED_PERMISSIONS } from '@contrataflow/validation';
import type { PermissionDto, RoleWithPermissionsDto } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { RoleDetailView } from './role-detail-view';
import { RolesView } from './roles-view';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
  usePathname: () => '/admin/perfis',
}));

let sequence = 0;
function role(overrides: Partial<RoleWithPermissionsDto> = {}): RoleWithPermissionsDto {
  sequence += 1;
  return {
    id: `0192a000-0000-7000-8000-${String(sequence).padStart(12, '0')}`,
    key: 'FISCAL_DE_OBRAS',
    name: 'Fiscal de Obras',
    description: null,
    isSystem: false,
    isProtected: false,
    allowExternalAssignment: false,
    isActive: true,
    activeAssignmentsCount: 0,
    permissions: [],
    createdAt: '2026-10-15T12:00:00.000Z',
    updatedAt: '2026-10-15T12:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

const ADMIN = role({
  key: 'ADMIN_ORGAO',
  name: 'Administrador do órgão',
  isSystem: true,
  isProtected: true,
  activeAssignmentsCount: 2,
  permissions: [...ADMIN_ORGAO_SEEDED_PERMISSIONS],
});
const AUDITOR = role({
  key: 'AUDITOR',
  name: 'Auditor',
  isSystem: true,
  allowExternalAssignment: true,
});
const FISCAL = role({ activeAssignmentsCount: 3, version: 4, permissions: ['PROCESS_VIEW'] });
const CATALOG: PermissionDto[] = PERMISSIONS.map((permission) => ({ ...permission }));

function problemResponse(
  status: number,
  code: string,
  detail: string,
  errors: { field: string; code: string; message: string }[] = [],
): Response {
  return new Response(
    JSON.stringify({
      type: `https://docs.contrataflow.com.br/errors/${code.toLowerCase()}`,
      title: code,
      status,
      detail,
      instance: '/api/v1/roles',
      code,
      correlationId: 'c-test',
      errors,
      violations: [],
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

/** Permissões efetivas de um administrador do órgão (ME-03). */
const ADMIN_CODES = [...ADMIN_ORGAO_SEEDED_PERMISSIONS];

function mockApi(
  routes: { list?: Handler; get?: Handler; post?: Handler; patch?: Handler; put?: Handler } = {},
  permissions: readonly string[] = ADMIN_CODES,
) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/v1/me/permissions')) {
      return Promise.resolve(
        jsonResponse({ data: { permissions: permissions.map((code) => ({ code, scopes: [] })) } }),
      );
    }
    if (url.startsWith('/api/v1/permissions')) {
      return Promise.resolve(jsonResponse({ data: CATALOG }));
    }
    if (method === 'GET' && url === '/api/v1/roles') {
      return Promise.resolve(
        (routes.list ?? (() => jsonResponse({ data: [ADMIN, AUDITOR, FISCAL] })))(url, init),
      );
    }
    if (method === 'GET' && url.startsWith('/api/v1/roles/')) {
      return Promise.resolve(
        (routes.get ?? (() => problemResponse(404, 'ROLE_NOT_FOUND', 'Perfil não encontrado.')))(
          url,
          init,
        ),
      );
    }
    const handler = { POST: routes.post, PATCH: routes.patch, PUT: routes.put }[method];
    return Promise.resolve(
      (handler ?? (() => problemResponse(500, 'INTERNAL_ERROR', 'x')))(url, init),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const bodyOf = (init?: RequestInit): Record<string, unknown> =>
  JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;

function callOf(api: ReturnType<typeof mockApi>, method: string, index = 0) {
  const call = api.mock.calls.filter(([, init]) => (init?.method ?? 'GET') === method)[index];
  if (!call) throw new Error(`sem chamada ${method} #${String(index)}`);
  return { url: requestUrl(call[0]), init: call[1], headers: new Headers(call[1]?.headers) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  push.mockReset();
});

describe('SCR-030 · lista de perfis (US-095)', () => {
  it('[Sucesso] lista padrão e personalizados com selos e vínculos; sem "Desativar" no ADMIN_ORGAO; sem violações de a11y', async () => {
    mockApi();
    renderWithShell(<RolesView />);

    const table = await screen.findByRole('table', { name: 'Perfis da instituição' });
    const admin = within(table).getByRole('row', { name: /Administrador do órgão/ });
    expect(within(admin).getByText('Padrão')).toBeTruthy();
    expect(within(admin).getByText('Protegido')).toBeTruthy();
    expect(within(admin).getByText('2 vínculos')).toBeTruthy();
    const fiscal = within(table).getByRole('row', { name: /Fiscal de Obras/ });
    expect(within(fiscal).getByText('Personalizado')).toBeTruthy();
    expect(within(table).getByRole('row', { name: /Auditor/ }).textContent).toContain(
      'Aceita vínculo externo',
    );

    // Ações com ROLE_MANAGE (ME-03); o ADMIN_ORGAO nunca mostra "Desativar" (FA-05).
    expect(
      await within(fiscal).findByRole('button', { name: 'Desativar Fiscal de Obras' }),
    ).toBeTruthy();
    expect(within(admin).queryByRole('button', { name: /Desativar/ })).toBeNull();
    expect(
      within(admin).getByRole('button', { name: 'Duplicar Administrador do órgão' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Novo perfil' })).toBeTruthy();
    expect(
      within(admin)
        .getByRole('link', { name: 'Abrir Administrador do órgão' })
        .getAttribute('href'),
    ).toBe(`/admin/perfis/${ADMIN.id}`);
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('carregando, vazio de personalizados e 403', async () => {
    mockApi({ list: () => new Promise<Response>(() => undefined) });
    const loading = renderWithShell(<RolesView />);
    expect((await screen.findByRole('status')).textContent).toContain('Carregando os perfis');
    loading.unmount();

    mockApi({ list: () => jsonResponse({ data: [ADMIN, AUDITOR] }) });
    const empty = renderWithShell(<RolesView />);
    expect(await screen.findByText('Nenhum perfil personalizado ainda')).toBeTruthy();
    empty.unmount();

    mockApi({ list: () => problemResponse(403, 'PERMISSION_DENIED', 'x') });
    renderWithShell(<RolesView />);
    expect(
      await screen.findByText('Você não tem permissão para ver perfis e permissões.'),
    ).toBeTruthy();
  });

  it('[Permissão] sem ROLE_MANAGE: lista somente leitura (sem "Novo perfil", "Duplicar" nem "Desativar")', async () => {
    mockApi({}, ['ROLE_VIEW']);
    renderWithShell(<RolesView />);
    await screen.findByRole('table', { name: 'Perfis da instituição' });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Novo perfil' })).toBeNull();
    });
    expect(screen.queryByRole('button', { name: /Duplicar|Desativar/ })).toBeNull();
  });

  it('[Sucesso] criar perfil: valida no cliente, envia ROL-03 e leva ao detalhe', async () => {
    const created = role({ name: 'Fiscal de Pontes', key: 'FISCAL_DE_PONTES' });
    const api = mockApi({
      post: () => jsonResponse({ data: created }, { status: 201, headers: { ETag: '"1"' } }),
    });
    const user = userEvent.setup();
    renderWithShell(<RolesView />);

    await user.click(await screen.findByRole('button', { name: 'Novo perfil' }));
    const name = await screen.findByLabelText('Nome *');
    await user.type(name, 'Fi');
    await user.click(screen.getByRole('button', { name: 'Criar perfil' }));
    expect(await screen.findByText('Informe um nome entre 3 e 120 caracteres.')).toBeTruthy();
    expect(api.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);

    await user.clear(name);
    await user.type(name, 'Fiscal de Pontes');
    await user.type(screen.getByLabelText('Descrição'), 'Pontes e viadutos');
    await user.click(screen.getByRole('button', { name: 'Criar perfil' }));

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(`/admin/perfis/${created.id}`);
    });
    const post = callOf(api, 'POST');
    expect(post.url).toBe('/api/v1/roles');
    expect(bodyOf(post.init)).toEqual({
      name: 'Fiscal de Pontes',
      description: 'Pontes e viadutos',
    });
  });

  it('[Duplicidade] 409 ROLE_ALREADY_EXISTS aparece no campo "Nome"', async () => {
    mockApi({
      post: () => problemResponse(409, 'ROLE_ALREADY_EXISTS', 'Já existe um perfil com esse nome.'),
    });
    const user = userEvent.setup();
    renderWithShell(<RolesView />);
    await user.click(await screen.findByRole('button', { name: 'Novo perfil' }));
    await user.type(await screen.findByLabelText('Nome *'), 'fiscal de obras');
    await user.click(screen.getByRole('button', { name: 'Criar perfil' }));
    expect(await screen.findByText('Já existe um perfil com esse nome.')).toBeTruthy();
    expect(screen.getByLabelText('Nome *').getAttribute('aria-invalid')).toBe('true');
  });

  it('FA-04: desativar com vínculos ativos exige a confirmação e envia confirmDeactivate com If-Match', async () => {
    const api = mockApi({
      post: () => jsonResponse({ data: { ...FISCAL, isActive: false, version: 5 } }),
    });
    const user = userEvent.setup();
    renderWithShell(<RolesView />);

    await user.click(await screen.findByRole('button', { name: 'Desativar Fiscal de Obras' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(
        '3 vínculos ativos usam este perfil e ficarão sem as permissões dele.',
      ),
    ).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: 'Desativar perfil' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(confirm);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const post = callOf(api, 'POST');
    expect(post.url).toBe(`/api/v1/roles/${FISCAL.id}/deactivate`);
    expect(post.headers.get('If-Match')).toBe('"4"');
    expect(bodyOf(post.init)).toEqual({ confirmDeactivate: true });
  });

  it('duplicar envia ROL-07; anti-escalonamento é explicado', async () => {
    const api = mockApi({
      post: () =>
        problemResponse(
          403,
          'PRIVILEGE_ESCALATION_FORBIDDEN',
          'Você não pode conceder uma permissão que você mesmo não possui.',
        ),
    });
    const user = userEvent.setup();
    renderWithShell(<RolesView />);
    await user.click(
      await screen.findByRole('button', { name: 'Duplicar Administrador do órgão' }),
    );
    expect(
      await screen.findByText('Você não pode conceder uma permissão que você mesmo não possui.'),
    ).toBeTruthy();
    expect(callOf(api, 'POST').url).toBe(`/api/v1/roles/${ADMIN.id}/duplicate`);
  });
});

describe('SCR-031 · matriz de permissões (US-095)', () => {
  const switchOf = (code: string) => {
    const element = document.querySelector(`[role="switch"][data-code="${code}"]`);
    if (!(element instanceof HTMLElement)) throw new Error(`sem interruptor ${code}`);
    return element;
  };

  it('[Sucesso] marcar SUPPLIER_VIEW e salvar: PUT com a lista completa e If-Match; sem violações de a11y', async () => {
    const saved = { ...FISCAL, permissions: ['PROCESS_VIEW', 'SUPPLIER_VIEW'], version: 5 };
    const api = mockApi({
      get: () => jsonResponse({ data: FISCAL }, { headers: { ETag: '"4"' } }),
      put: () => jsonResponse({ data: saved }, { headers: { ETag: '"5"' } }),
    });
    const user = userEvent.setup();
    renderWithShell(<RoleDetailView roleId={FISCAL.id} />);

    expect(await screen.findByRole('heading', { name: 'Fiscal de Obras', level: 1 })).toBeTruthy();
    expect(switchOf('PROCESS_VIEW').getAttribute('aria-checked')).toBe('true');
    expect(switchOf('SUPPLIER_VIEW').getAttribute('aria-checked')).toBe('false');
    expect(await seriousA11yViolations()).toEqual([]);

    await waitFor(() => {
      expect(switchOf('SUPPLIER_VIEW').getAttribute('aria-disabled')).toBeNull();
    });
    await user.click(switchOf('SUPPLIER_VIEW'));
    expect(switchOf('SUPPLIER_VIEW').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('1 a conceder')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Salvar matriz' }));

    await waitFor(() => {
      expect(screen.getByText('Nenhuma alteração pendente.')).toBeTruthy();
    });
    const put = callOf(api, 'PUT');
    expect(put.url).toBe(`/api/v1/roles/${FISCAL.id}/permissions`);
    expect(put.headers.get('If-Match')).toBe('"4"');
    expect(bodyOf(put.init)).toEqual({ permissions: ['PROCESS_VIEW', 'SUPPLIER_VIEW'] });
  });

  it('FA-01: no ADMIN_ORGAO as permissões semeadas ficam travadas com a dica; "Desativar" não aparece', async () => {
    mockApi({ get: () => jsonResponse({ data: ADMIN }) });
    renderWithShell(<RoleDetailView roleId={ADMIN.id} />);
    await screen.findByRole('heading', { name: 'Administrador do órgão', level: 1 });
    await waitFor(() => {
      expect(switchOf('USER_MANAGE').getAttribute('aria-disabled')).toBe('true');
    });
    expect(switchOf('USER_MANAGE').getAttribute('aria-checked')).toBe('true');
    expect(switchOf('USER_MANAGE').getAttribute('title')).toBe(
      'Permissão protegida — não pode ser removida do Administrador do órgão.',
    );
    // O administrador (isento de POL-13) pode acrescentar permissões novas.
    expect(switchOf('SUPPLIER_VIEW').getAttribute('aria-disabled')).toBeNull();
    expect(await screen.findByRole('button', { name: 'Editar perfil' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Desativar' })).toBeNull();
  });

  it('FA-02: quem não é administrador vê travadas as permissões que não possui; 403 da API desfaz a marcação', async () => {
    mockApi(
      {
        get: () => jsonResponse({ data: FISCAL }),
        put: () =>
          problemResponse(
            403,
            'PRIVILEGE_ESCALATION_FORBIDDEN',
            'Você não pode conceder uma permissão que você mesmo não possui.',
          ),
      },
      ['ROLE_VIEW', 'ROLE_MANAGE', 'PROCESS_VIEW', 'DFD_CREATE'],
    );
    const user = userEvent.setup();
    renderWithShell(<RoleDetailView roleId={FISCAL.id} />);
    await screen.findByRole('heading', { name: 'Fiscal de Obras', level: 1 });
    await waitFor(() => {
      expect(switchOf('SETTINGS_MANAGE').getAttribute('aria-disabled')).toBe('true');
    });
    expect(switchOf('SETTINGS_MANAGE').getAttribute('title')).toBe(
      'Você não possui esta permissão e por isso não pode concedê-la.',
    );
    await user.click(switchOf('SETTINGS_MANAGE'));
    expect(switchOf('SETTINGS_MANAGE').getAttribute('aria-checked')).toBe('false');

    // Se a API ainda recusar (ex.: permissões efetivas desatualizadas), o interruptor volta.
    await user.click(switchOf('DFD_CREATE'));
    await user.click(screen.getByRole('button', { name: 'Salvar matriz' }));
    expect(
      await screen.findByText('Você não pode conceder uma permissão que você mesmo não possui.'),
    ).toBeTruthy();
    expect(switchOf('DFD_CREATE').getAttribute('aria-checked')).toBe('false');
  });

  it('[Concorrência] 412 oferece "Recarregar"; MFA_REQUIRED oferece o step-up', async () => {
    let attempt = 0;
    mockApi({
      get: () => jsonResponse({ data: FISCAL }),
      put: () => {
        attempt += 1;
        return attempt === 1
          ? problemResponse(412, 'VERSION_CONFLICT', 'x')
          : problemResponse(403, 'MFA_REQUIRED', 'Confirme sua identidade para continuar.');
      },
    });
    const user = userEvent.setup();
    renderWithShell(<RoleDetailView roleId={FISCAL.id} />);
    await screen.findByRole('heading', { name: 'Fiscal de Obras', level: 1 });
    await waitFor(() => {
      expect(switchOf('SUPPLIER_VIEW').getAttribute('aria-disabled')).toBeNull();
    });
    await user.click(switchOf('SUPPLIER_VIEW'));
    await user.click(screen.getByRole('button', { name: 'Salvar matriz' }));
    expect(
      await screen.findByText(
        'Este perfil foi alterado por outra pessoa. Recarregue para ver a versão atual.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Recarregar' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Salvar matriz' }));
    const link = await screen.findByRole('link', { name: 'Confirmar identidade' });
    expect(link.getAttribute('href')).toBe(
      `/api/auth/step-up?returnTo=%2Fadmin%2Fperfis%2F${FISCAL.id}`,
    );
  });

  it('[Permissão] sem ROLE_MANAGE a matriz é somente leitura; perfil de outro tenant → "Perfil não encontrado."', async () => {
    mockApi({ get: () => jsonResponse({ data: FISCAL }) }, ['ROLE_VIEW']);
    const view = renderWithShell(<RoleDetailView roleId={FISCAL.id} />);
    expect(
      await screen.findByText('Você pode consultar a matriz, mas não alterá-la.'),
    ).toBeTruthy();
    expect(switchOf('PROCESS_VIEW').getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Salvar matriz' })).toBeNull();
    view.unmount();

    mockApi();
    renderWithShell(<RoleDetailView roleId={FISCAL.id} />);
    expect(await screen.findByText('Perfil não encontrado.')).toBeTruthy();
  });
});
