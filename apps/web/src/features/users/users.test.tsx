// @vitest-environment jsdom
import type { RoleDto, TenantMembershipDto } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import {
  endOfLocalDayIso,
  inviteFieldOf,
  validateInvite,
  EMPTY_INVITE_FORM,
} from './invite-form-model';
import { UsersView } from './users-view';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

const ADMIN_CODES = ['USER_VIEW', 'USER_INVITE', 'ROLE_VIEW'];

let sequence = 0;
function invitation(overrides: Partial<TenantMembershipDto> = {}): TenantMembershipDto {
  sequence += 1;
  const n = String(sequence).padStart(12, '0');
  return {
    id: `0192a000-0000-7000-8000-${n}`,
    userId: `0192a000-0000-7000-9000-${n}`,
    name: 'Carla Mendes',
    socialName: null,
    email: 'carla@exemplo.gov.br',
    type: 'INTERNAL',
    status: 'INVITED',
    jobTitle: null,
    registrationNumber: null,
    expiresAt: null,
    departmentIds: [],
    primaryDepartmentId: null,
    invitedAt: '2026-10-15T12:00:00.000Z',
    inviteExpiresAt: '2026-10-22T12:00:00.000Z',
    activatedAt: null,
    version: 1,
    ...overrides,
  };
}

const CARLA = invitation();
const PEDRO = invitation({
  name: 'Pedro Alves',
  email: 'pedro@fornecedor.com.br',
  type: 'EXTERNAL',
});

const OBRAS = {
  id: '0192a000-0000-7000-8000-0000000000d1',
  name: 'Secretaria de Obras',
  type: 'SECRETARIAT',
  path: 'Secretaria de Obras',
};
const PROTOCOLO = {
  id: '0192a000-0000-7000-8000-0000000000d2',
  name: 'Protocolo',
  type: 'SECTOR',
  path: 'Secretaria de Obras / Protocolo',
};

function role(overrides: Partial<RoleDto> = {}): RoleDto {
  return {
    id: '0192a000-0000-7000-8000-0000000000f1',
    key: 'SOLICITANTE',
    name: 'Solicitante',
    description: null,
    isSystem: true,
    isProtected: false,
    allowExternalAssignment: false,
    isActive: true,
    activeAssignmentsCount: 0,
    createdAt: '2026-10-15T12:00:00.000Z',
    updatedAt: '2026-10-15T12:00:00.000Z',
    version: 1,
    ...overrides,
  };
}
const SOLICITANTE = role();
const FORNECEDOR = role({
  id: '0192a000-0000-7000-8000-0000000000f2',
  key: 'FORNECEDOR',
  name: 'Fornecedor',
  allowExternalAssignment: true,
});

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
      instance: '/api/v1/users',
      code,
      correlationId: 'c-test',
      errors,
      violations: [],
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

interface Routes {
  /** USR-01 com `status=INVITED` (convites pendentes). */
  list?: Handler;
  /** USR-01 da lista de usuários (os demais status). */
  members?: Handler;
  invite?: Handler;
  resend?: Handler;
  cancel?: Handler;
  roles?: Handler;
}

function mockApi(routes: Routes = {}, permissions: readonly string[] = ADMIN_CODES) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    const respond = (handler: Handler | undefined, fallback: Handler) =>
      Promise.resolve((handler ?? fallback)(url, init));
    if (url.startsWith('/api/v1/me/permissions')) {
      return Promise.resolve(
        jsonResponse({ data: { permissions: permissions.map((code) => ({ code, scopes: [] })) } }),
      );
    }
    if (method === 'GET' && url.startsWith('/api/v1/users?') && !url.includes('status=INVITED')) {
      return respond(routes.members, () =>
        jsonResponse({
          data: [],
          meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
        }),
      );
    }
    if (method === 'GET' && url.startsWith('/api/v1/users?')) {
      return respond(routes.list, () =>
        jsonResponse({
          data: [CARLA, PEDRO],
          meta: { page: 1, pageSize: 20, totalItems: 2, totalPages: 1 },
        }),
      );
    }
    if (method === 'GET' && url.startsWith('/api/v1/departments/lookup')) {
      return Promise.resolve(jsonResponse({ data: [OBRAS, PROTOCOLO] }));
    }
    if (method === 'GET' && url.startsWith('/api/v1/roles')) {
      return respond(routes.roles, () => jsonResponse({ data: [SOLICITANTE, FORNECEDOR] }));
    }
    if (method === 'POST' && url === '/api/v1/users/invitations') {
      return respond(routes.invite, () => jsonResponse({ data: invitation() }, { status: 201 }));
    }
    if (method === 'POST' && url.endsWith('/resend')) {
      return respond(routes.resend, () =>
        jsonResponse({ data: { inviteExpiresAt: '2026-10-29T12:00:00.000Z' } }),
      );
    }
    if (method === 'DELETE' && url.startsWith('/api/v1/users/invitations/')) {
      return respond(routes.cancel, () => new Response(null, { status: 204 }));
    }
    return Promise.resolve(problemResponse(500, 'INTERNAL_ERROR', 'x'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const bodyOf = (init?: RequestInit): Record<string, unknown> =>
  JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;

function callsOf(api: ReturnType<typeof mockApi>, method: string, urlPart: string) {
  return api.mock.calls
    .filter(
      ([input, init]) => (init?.method ?? 'GET') === method && requestUrl(input).includes(urlPart),
    )
    .map(([input, init]) => ({
      url: requestUrl(input),
      init,
      headers: new Headers(init?.headers),
      body: bodyOf(init),
    }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

type User = ReturnType<typeof userEvent.setup>;

async function openInviteDialog(user: User) {
  await user.click(await screen.findByRole('button', { name: 'Convidar usuário' }));
  return screen.findByRole('dialog', { name: 'Convidar usuário' });
}

/** Abre um `Select`/`Combobox` do kit pelo nome e escolhe a opção (a lista é um portal). */
async function pick(user: User, scope: HTMLElement, field: string, option: string | RegExp) {
  await user.click(within(scope).getByLabelText(field));
  await user.click(await screen.findByRole('option', { name: option }));
}

/** Escolhe o dia 15 do mês seguinte no `DatePicker`; devolve ano e mês (0-11) escolhidos. */
async function pickNextMonthDay15(user: User, scope: HTMLElement, field: string) {
  await user.click(within(scope).getByLabelText(field));
  const calendar = await screen.findByRole('dialog', { name: 'Escolher data' });
  await user.click(within(calendar).getByRole('button', { name: 'Ir para o próximo mês' }));
  const [day] = within(calendar).getAllByRole('button', { name: /, 15 de / });
  if (!day) throw new Error('dia 15 não encontrado no calendário');
  await user.click(day);
  const target = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 15);
  return { year: target.getFullYear(), month: target.getMonth() };
}

/** Abre "Adicionar unidade" e marca as unidades pelo nome (a lista continua aberta). */
async function addDepartments(user: User, scope: HTMLElement, names: readonly RegExp[]) {
  await user.click(within(scope).getByRole('button', { name: 'Adicionar unidade' }));
  for (const name of names) {
    await user.click(await screen.findByRole('option', { name }));
  }
  await user.keyboard('{Escape}');
}

/** Abre o menu ⋯ do convite e escolhe a ação. */
async function chooseInviteAction(user: User, invitee: string, action: string) {
  await user.click(await screen.findByRole('button', { name: `Ações do convite de ${invitee}` }));
  await user.click(await screen.findByRole('menuitem', { name: action }));
}

describe('modelo do formulário de convite (RN-IAM-52)', () => {
  it('fim do dia local em ISO UTC e vazio/inválido sem valor', () => {
    const iso = endOfLocalDayIso('2026-12-31');
    const local = new Date(iso ?? '');
    expect([local.getFullYear(), local.getMonth(), local.getDate(), local.getHours()]).toEqual([
      2026, 11, 31, 23,
    ]);
    expect(iso?.endsWith('Z')).toBe(true);
    expect(endOfLocalDayIso('')).toBeUndefined();
    expect(endOfLocalDayIso('31/12/2026')).toBeUndefined();
  });

  it('valida com o schema da API e mapeia o campo pelo caminho', () => {
    const result = validateInvite({
      ...EMPTY_INVITE_FORM,
      email: 'x',
      name: 'Ana Souza',
      type: 'EXTERNAL',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.email).toBe('Informe um e-mail válido.');
      expect(result.errors.expiresAt).toBe('Informe a validade do vínculo externo.');
    }
    expect(inviteFieldOf(['departmentIds', 0])).toBe('departmentIds');
    expect(inviteFieldOf('departmentIds[1]')).toBe('departmentIds');
    expect(inviteFieldOf('desconhecido')).toBeNull();
  });
});

describe('SCR-029 · convites pendentes (US-091)', () => {
  it('[Sucesso] lista os convites pendentes com ações; sem violações de a11y', async () => {
    const api = mockApi();
    renderWithShell(<UsersView />);

    const table = await screen.findByRole('table', { name: 'Convites pendentes da instituição' });
    const carla = within(table).getByRole('row', { name: /Carla Mendes/ });
    expect(within(carla).getByText('carla@exemplo.gov.br')).toBeTruthy();
    expect(within(carla).getByText('Interno')).toBeTruthy();
    expect(within(table).getByRole('row', { name: /Pedro Alves/ }).textContent).toContain(
      'Externo',
    );
    await userEvent.click(
      await within(carla).findByRole('button', { name: 'Ações do convite de Carla Mendes' }),
    );
    expect(
      await screen.findByRole('menuitem', { name: 'Reenviar convite para Carla Mendes' }),
    ).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Cancelar convite de Carla Mendes' })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(await screen.findByRole('button', { name: 'Convidar usuário' })).toBeTruthy();
    expect(callsOf(api, 'GET', 'status=INVITED')[0]?.url).toBe(
      '/api/v1/users?status=INVITED&page=1&pageSize=20',
    );
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('carregando, vazio, erro com "Tentar novamente" e 403', async () => {
    mockApi({ list: () => new Promise<Response>(() => undefined) });
    const loading = renderWithShell(<UsersView />);
    expect(await screen.findByText('Carregando os convites…')).toBeTruthy();
    loading.unmount();

    mockApi({
      list: () =>
        jsonResponse({ data: [], meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 } }),
    });
    const empty = renderWithShell(<UsersView />);
    expect(await screen.findByText('Nenhum convite pendente')).toBeTruthy();
    empty.unmount();

    let recovered = false;
    mockApi({
      list: () => {
        return !recovered
          ? problemResponse(500, 'INTERNAL_ERROR', 'x')
          : jsonResponse({
              data: [CARLA],
              meta: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
            });
      },
    });
    const user = userEvent.setup();
    const failing = renderWithShell(<UsersView />);
    // Falha 5xx: duas retentativas da política global (1 s + 2 s) antes do erro na lista.
    expect(
      await screen.findByText('Não foi possível carregar os convites.', {}, { timeout: 10_000 }),
    ).toBeTruthy();
    recovered = true;
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(
      await screen.findByRole('table', { name: 'Convites pendentes da instituição' }),
    ).toBeTruthy();
    failing.unmount();

    mockApi({ list: () => problemResponse(403, 'PERMISSION_DENIED', 'x') });
    renderWithShell(<UsersView />);
    expect(await screen.findByText('Você não tem acesso a esta área')).toBeTruthy();
  });

  it('[Permissão] sem USER_INVITE: sem "Convidar usuário", "Reenviar" nem "Cancelar"', async () => {
    mockApi({}, ['USER_VIEW']);
    renderWithShell(<UsersView />);
    await screen.findByRole('table', { name: 'Convites pendentes da instituição' });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Convidar usuário' })).toBeNull();
    });
    expect(screen.queryByRole('button', { name: /Ações do convite/ })).toBeNull();
  });

  it('[Reenvio] USR-04 envia o reenvio; 429 mostra a mensagem da API', async () => {
    let calls = 0;
    const api = mockApi({
      resend: () => {
        calls += 1;
        return calls === 1
          ? jsonResponse({ data: { inviteExpiresAt: '2026-10-29T12:00:00.000Z' } })
          : problemResponse(429, 'RATE_LIMITED', 'Aguarde 1 minuto para reenviar este convite.');
      },
    });
    const user = userEvent.setup();
    renderWithShell(<UsersView />);
    await chooseInviteAction(user, 'Carla Mendes', 'Reenviar convite para Carla Mendes');
    await waitFor(() => {
      expect(callsOf(api, 'POST', '/resend')).toHaveLength(1);
    });
    expect(callsOf(api, 'POST', '/resend')[0]?.url).toBe(
      `/api/v1/users/invitations/${CARLA.userId}/resend`,
    );

    await chooseInviteAction(user, 'Carla Mendes', 'Reenviar convite para Carla Mendes');
    expect(await screen.findByText('Aguarde 1 minuto para reenviar este convite.')).toBeTruthy();
  });

  it('[Cancelamento] pede confirmação (alertdialog) e envia USR-05; manter não cancela', async () => {
    const api = mockApi();
    const user = userEvent.setup();
    renderWithShell(<UsersView />);

    await chooseInviteAction(user, 'Carla Mendes', 'Cancelar convite de Carla Mendes');
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Cancelar o convite de Carla Mendes?',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Manter convite' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect(callsOf(api, 'DELETE', '/users/invitations/')).toHaveLength(0);

    await chooseInviteAction(user, 'Carla Mendes', 'Cancelar convite de Carla Mendes');
    const again = await screen.findByRole('alertdialog');
    await user.click(within(again).getByRole('button', { name: 'Cancelar convite' }));
    await waitFor(() => {
      expect(callsOf(api, 'DELETE', '/users/invitations/')).toHaveLength(1);
    });
    expect(callsOf(api, 'DELETE', '/users/invitations/')[0]?.url).toBe(
      `/api/v1/users/invitations/${CARLA.userId}`,
    );
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
  });
});

describe('InviteUserForm (US-091 · USR-03)', () => {
  it('[Sucesso] interno: valida, envia com Idempotency-Key, lotação principal e perfil', async () => {
    const api = mockApi();
    const user = userEvent.setup();
    renderWithShell(<UsersView />);
    const dialog = await openInviteDialog(user);

    expect(within(dialog).getByLabelText('E-mail *')).toBe(document.activeElement);
    // Perfil inicial aparece com ROLE_VIEW; validade só para vínculo externo.
    expect(await within(dialog).findByLabelText('Perfil inicial')).toBeTruthy();
    expect(within(dialog).queryByLabelText('Validade do vínculo *')).toBeNull();
    expect(await seriousA11yViolations()).toEqual([]);

    await user.type(within(dialog).getByLabelText('E-mail *'), '  Marta@Exemplo.gov.br ');
    await user.type(within(dialog).getByLabelText('Nome *'), 'Marta Lima');
    await user.type(within(dialog).getByLabelText('Cargo ou função'), 'Engenheira');
    await addDepartments(user, dialog, [/^Secretaria de Obras/, /^Protocolo/]);
    expect(
      within(within(dialog).getByRole('list', { name: 'Unidades selecionadas' })).getByText(
        '(principal)',
      ),
    ).toBeTruthy();
    await pick(user, dialog, 'Perfil inicial', 'Solicitante');
    await user.click(within(dialog).getByRole('button', { name: 'Enviar convite' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const [post] = callsOf(api, 'POST', '/api/v1/users/invitations');
    expect(post?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(post?.body).toEqual({
      email: 'marta@exemplo.gov.br',
      name: 'Marta Lima',
      type: 'INTERNAL',
      jobTitle: 'Engenheira',
      departmentIds: [OBRAS.id, PROTOCOLO.id],
      roleId: SOLICITANTE.id,
    });
  });

  it('[Validação] e-mail inválido e EXTERNAL sem validade: nada é enviado e o foco vai ao primeiro erro', async () => {
    const api = mockApi();
    const user = userEvent.setup();
    renderWithShell(<UsersView />);
    const dialog = await openInviteDialog(user);

    await user.type(within(dialog).getByLabelText('E-mail *'), 'sem-arroba');
    await user.type(within(dialog).getByLabelText('Nome *'), 'Pedro Alves');
    await pick(user, dialog, 'Tipo de vínculo *', /^Externo/);
    await user.click(within(dialog).getByRole('button', { name: 'Enviar convite' }));

    expect(await within(dialog).findByText('Informe um e-mail válido.')).toBeTruthy();
    expect(within(dialog).getByText('Informe a validade do vínculo externo.')).toBeTruthy();
    expect(within(dialog).getByLabelText('E-mail *')).toBe(document.activeElement);
    expect(within(dialog).getByLabelText('E-mail *').getAttribute('aria-invalid')).toBe('true');
    expect(callsOf(api, 'POST', '/api/v1/users/invitations')).toHaveLength(0);

    // Corrigido o e-mail, o próximo erro (validade) recebe o foco.
    await user.clear(within(dialog).getByLabelText('E-mail *'));
    await user.type(within(dialog).getByLabelText('E-mail *'), 'pedro@fornecedor.com.br');
    await user.click(within(dialog).getByRole('button', { name: 'Enviar convite' }));
    await waitFor(() => {
      expect(within(dialog).getByLabelText('Validade do vínculo *')).toBe(document.activeElement);
    });
  });

  it('[Externo] envia a validade como ISO UTC do fim do dia local; só perfis que aceitam externo', async () => {
    const api = mockApi();
    const user = userEvent.setup();
    renderWithShell(<UsersView />);
    const dialog = await openInviteDialog(user);

    await user.type(within(dialog).getByLabelText('E-mail *'), 'pedro@fornecedor.com.br');
    await user.type(within(dialog).getByLabelText('Nome *'), 'Pedro Alves');
    await pick(user, dialog, 'Tipo de vínculo *', /^Externo/);
    const { year, month } = await pickNextMonthDay15(user, dialog, 'Validade do vínculo *');
    await user.click(await within(dialog).findByLabelText('Perfil inicial'));
    expect(screen.queryByRole('option', { name: 'Solicitante' })).toBeNull();
    await user.click(await screen.findByRole('option', { name: 'Fornecedor' }));
    await user.click(within(dialog).getByRole('button', { name: 'Enviar convite' }));

    await waitFor(() => {
      expect(callsOf(api, 'POST', '/api/v1/users/invitations')).toHaveLength(1);
    });
    const body = callsOf(api, 'POST', '/api/v1/users/invitations')[0]?.body ?? {};
    expect(body).toMatchObject({ type: 'EXTERNAL', roleId: FORNECEDOR.id });
    const expires = new Date(String(body.expiresAt));
    expect([
      expires.getFullYear(),
      expires.getMonth(),
      expires.getDate(),
      expires.getHours(),
    ]).toEqual([year, month, 15, 23]);
  });

  it('[Perfil] sem ROLE_VIEW (403) o campo "Perfil inicial" não aparece', async () => {
    mockApi({ roles: () => problemResponse(403, 'PERMISSION_DENIED', 'x') }, [
      'USER_VIEW',
      'USER_INVITE',
    ]);
    const user = userEvent.setup();
    renderWithShell(<UsersView />);
    const dialog = await openInviteDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Adicionar unidade' }));
    await screen.findByRole('option', { name: /^Secretaria de Obras/ });
    expect(within(dialog).queryByLabelText('Perfil inicial')).toBeNull();
  });

  it('[Duplicidade] 409 MEMBERSHIP_ALREADY_EXISTS no campo e-mail e sugere reenviar', async () => {
    mockApi({
      invite: () =>
        problemResponse(
          409,
          'MEMBERSHIP_ALREADY_EXISTS',
          'Esta pessoa já tem um vínculo com esta instituição.',
        ),
    });
    const user = userEvent.setup();
    renderWithShell(<UsersView />);
    const dialog = await openInviteDialog(user);
    await user.type(within(dialog).getByLabelText('E-mail *'), 'carla@exemplo.gov.br');
    await user.type(within(dialog).getByLabelText('Nome *'), 'Carla Mendes');
    await user.click(within(dialog).getByRole('button', { name: 'Enviar convite' }));

    expect(
      await within(dialog).findByText('Esta pessoa já tem um vínculo com esta instituição.'),
    ).toBeTruthy();
    expect(within(dialog).getByText(/use "Reenviar" na lista de convites/)).toBeTruthy();
    expect(within(dialog).getByLabelText('E-mail *').getAttribute('aria-invalid')).toBe('true');
  });

  it('[422] erros da API vão para os campos e o foco para o primeiro', async () => {
    mockApi({
      invite: () =>
        problemResponse(422, 'VALIDATION_ERROR', 'Dados inválidos.', [
          {
            field: 'expiresAt',
            code: 'DATE_IN_PAST',
            message: 'A validade deve ser uma data futura.',
          },
          {
            field: 'roleId',
            code: 'REFERENCE_INACTIVE',
            message: 'O perfil selecionado está inativo.',
          },
        ]),
    });
    const user = userEvent.setup();
    renderWithShell(<UsersView />);
    const dialog = await openInviteDialog(user);
    await user.type(within(dialog).getByLabelText('E-mail *'), 'pedro@fornecedor.com.br');
    await user.type(within(dialog).getByLabelText('Nome *'), 'Pedro Alves');
    await pick(user, dialog, 'Tipo de vínculo *', /^Externo/);
    await pickNextMonthDay15(user, dialog, 'Validade do vínculo *');
    await user.click(within(dialog).getByRole('button', { name: 'Enviar convite' }));

    expect(await within(dialog).findByText('A validade deve ser uma data futura.')).toBeTruthy();
    expect(within(dialog).getByText('O perfil selecionado está inativo.')).toBeTruthy();
    await waitFor(() => {
      expect(within(dialog).getByLabelText('Validade do vínculo *')).toBe(document.activeElement);
    });
  });

  it('[503] mantém os dados do formulário e repete com a mesma Idempotency-Key', async () => {
    const api = mockApi({
      invite: () => problemResponse(503, 'DEPENDENCY_UNAVAILABLE', 'Indisponível.'),
    });
    const user = userEvent.setup();
    renderWithShell(<UsersView />);
    const dialog = await openInviteDialog(user);
    await user.type(within(dialog).getByLabelText('E-mail *'), 'marta@exemplo.gov.br');
    await user.type(within(dialog).getByLabelText('Nome *'), 'Marta Lima');
    await user.click(within(dialog).getByRole('button', { name: 'Enviar convite' }));

    expect(
      await within(dialog).findByText(
        'Não foi possível enviar o convite agora. Tente novamente em instantes.',
      ),
    ).toBeTruthy();
    expect(within(dialog).getByLabelText<HTMLInputElement>('E-mail *').value).toBe(
      'marta@exemplo.gov.br',
    );
    expect(within(dialog).getByLabelText<HTMLInputElement>('Nome *').value).toBe('Marta Lima');
    const posts = callsOf(api, 'POST', '/api/v1/users/invitations');
    expect(posts.length).toBeGreaterThan(1);
    expect(new Set(posts.map((post) => post.headers.get('Idempotency-Key'))).size).toBe(1);
  });

  it('[MFA] MFA_REQUIRED oferece o step-up', async () => {
    mockApi({ invite: () => problemResponse(403, 'MFA_REQUIRED', 'Confirme a identidade.') });
    const user = userEvent.setup();
    renderWithShell(<UsersView />);
    const dialog = await openInviteDialog(user);
    await user.type(within(dialog).getByLabelText('E-mail *'), 'marta@exemplo.gov.br');
    await user.type(within(dialog).getByLabelText('Nome *'), 'Marta Lima');
    await user.click(within(dialog).getByRole('button', { name: 'Enviar convite' }));
    const link = await within(dialog).findByRole('link', { name: 'Confirmar identidade' });
    expect(link.getAttribute('href')).toContain('/api/auth/step-up?returnTo=');
  });
});
