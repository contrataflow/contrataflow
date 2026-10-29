// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import type {
  RoleAssignmentDto,
  RoleDto,
  TenantMembershipDetailDto,
} from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import {
  assignmentPhase,
  toAssignInput,
  validateAssign,
  EMPTY_ASSIGN_FORM,
} from './role-assignment-model';
import { RoleAssignmentsSection } from './role-assignments-section';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

const USER_ID = '0192a000-0000-7000-9000-000000000001';
const MEMBERSHIP_ID = '0192a000-0000-7000-8000-000000000001';
const OBRAS = '0192a000-0000-7000-8000-0000000000c1';
const ORG = '0192a000-0000-7000-8000-0000000000f1';
const REQUISITANTE = '0192a000-0000-7000-8000-0000000000a1';
const AUDITOR = '0192a000-0000-7000-8000-0000000000a2';
const ADMIN = '0192a000-0000-7000-8000-0000000000a3';

function member(overrides: Partial<TenantMembershipDetailDto> = {}): TenantMembershipDetailDto {
  return {
    id: MEMBERSHIP_ID,
    userId: USER_ID,
    name: 'Bruno Lima',
    socialName: null,
    email: 'bruno@exemplo.gov.br',
    type: 'INTERNAL',
    status: 'ACTIVE',
    jobTitle: null,
    registrationNumber: null,
    expiresAt: null,
    departmentIds: [],
    primaryDepartmentId: null,
    invitedAt: null,
    inviteExpiresAt: null,
    activatedAt: null,
    version: 1,
    departments: [],
    suspendedAt: null,
    suspensionReason: null,
    revokedAt: null,
    revocationReason: null,
    ...overrides,
  };
}

function assignment(overrides: Partial<RoleAssignmentDto> = {}): RoleAssignmentDto {
  return {
    id: '0192a000-0000-7000-8000-0000000000b1',
    membershipId: MEMBERSHIP_ID,
    userId: USER_ID,
    userName: 'Bruno Lima',
    roleId: REQUISITANTE,
    roleKey: 'REQUISITANTE',
    roleName: 'Requisitante',
    isAdministrative: false,
    scopeType: 'DEPARTMENT',
    scopeOrganizationId: null,
    scopeDepartmentId: OBRAS,
    scopeName: 'Secretaria de Obras',
    includeSubtree: true,
    validFrom: '2026-01-01T03:00:00.000Z',
    validUntil: null,
    status: 'ACTIVE',
    grantedBy: { id: '0192a000-0000-7000-8000-0000000000d1', name: 'Carla Souza' },
    grantedAt: '2026-01-01T03:00:00.000Z',
    revokedAt: null,
    version: 1,
    ...overrides,
  };
}

function role(id: string, name: string, allowExternalAssignment = false): RoleDto {
  return {
    id,
    key: name.toUpperCase(),
    name,
    description: null,
    isSystem: true,
    isProtected: false,
    allowExternalAssignment,
    isActive: true,
    activeAssignmentsCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
  };
}

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
      instance: '/api/v1/x',
      code,
      correlationId: 'c-test',
      errors,
      violations: [],
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

type Handler = (url: string, init?: RequestInit) => Response;

interface Routes {
  list?: Handler;
  assign?: Handler;
  revoke?: Handler;
}

function mockApi(routes: Routes = {}) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    const respond = (handler: Handler | undefined, fallback: Handler) =>
      Promise.resolve((handler ?? fallback)(url, init));
    if (url.startsWith('/api/v1/me/permissions')) {
      return Promise.resolve(jsonResponse({ data: { permissions: [] } }));
    }
    if (method === 'GET' && url.startsWith('/api/v1/roles')) {
      return Promise.resolve(
        jsonResponse({
          data: [
            role(REQUISITANTE, 'Requisitante'),
            role(AUDITOR, 'Auditor', true),
            role(ADMIN, 'Administrador do órgão'),
          ],
        }),
      );
    }
    if (method === 'GET' && url.startsWith('/api/v1/organizations')) {
      return Promise.resolve(
        jsonResponse({
          data: [{ id: ORG, name: 'Prefeitura Municipal', isActive: true }],
          meta: { page: 1, pageSize: 100, total: 1 },
        }),
      );
    }
    if (method === 'GET' && url.startsWith('/api/v1/departments/lookup')) {
      return Promise.resolve(
        jsonResponse({
          data: [{ id: OBRAS, name: 'Obras', type: 'SECRETARIAT', path: 'Secretaria de Obras' }],
        }),
      );
    }
    const base = `/api/v1/users/${USER_ID}/role-assignments`;
    if (method === 'GET' && url === base) {
      return respond(routes.list, () =>
        jsonResponse({ data: [assignment()], meta: { canAssign: true, isSelf: false } }),
      );
    }
    if (method === 'POST' && url === base) {
      return respond(routes.assign, () =>
        jsonResponse({ data: assignment({ id: 'novo', roleName: 'Auditor' }) }, { status: 201 }),
      );
    }
    if (method === 'POST' && url.startsWith('/api/v1/role-assignments/')) {
      return respond(routes.revoke, () =>
        jsonResponse({ data: assignment({ status: 'REVOKED', version: 2 }) }),
      );
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
      headers: new Headers(init?.headers),
      body: bodyOf(init),
    }));
}

afterEach(() => {
  clearToasts();
  vi.unstubAllGlobals();
});

const open = (membership = member()) =>
  renderWithShell(
    <>
      <RoleAssignmentsSection membership={membership} returnTo={`/admin/usuarios/${USER_ID}`} />
      <Toaster />
    </>,
  );

describe('modelo do formulário (RN-IAM-89/93)', () => {
  const now = new Date('2026-10-16T12:00:00');

  it('corpo só com o que vale para o escopo; início hoje fica a cargo da API', () => {
    expect(toAssignInput({ ...EMPTY_ASSIGN_FORM, roleId: REQUISITANTE }, now)).toEqual({
      roleId: REQUISITANTE,
      scopeType: 'TENANT',
    });
    const department = toAssignInput(
      {
        ...EMPTY_ASSIGN_FORM,
        roleId: REQUISITANTE,
        scopeType: 'DEPARTMENT',
        scopeDepartmentId: OBRAS,
        includeSubtree: false,
        validFromDate: '2026-10-16',
        validUntilDate: '2026-12-31',
      },
      now,
    );
    expect(department).toMatchObject({
      scopeDepartmentId: OBRAS,
      includeSubtree: false,
      validUntil: new Date(2026, 11, 31, 23, 59, 59, 999).toISOString(),
    });
    expect(department).not.toHaveProperty('validFrom');
    expect(
      toAssignInput(
        { ...EMPTY_ASSIGN_FORM, roleId: REQUISITANTE, validFromDate: '2026-11-01' },
        now,
      ).validFrom,
    ).toBe(new Date(2026, 10, 1).toISOString());
  });

  it('V-01/V-02/V-04 e validade do vínculo externo', () => {
    const internal = { type: 'INTERNAL' as const, expiresAt: null };
    expect(validateAssign(EMPTY_ASSIGN_FORM, internal, now).errors).toEqual({
      roleId: 'Selecione o perfil e o escopo.',
    });
    expect(
      validateAssign(
        { ...EMPTY_ASSIGN_FORM, roleId: REQUISITANTE, scopeType: 'ORGANIZATION' },
        internal,
        now,
      ).errors,
    ).toEqual({ scopeOrganizationId: 'Informe o órgão para este escopo.' });
    expect(
      validateAssign(
        {
          ...EMPTY_ASSIGN_FORM,
          roleId: REQUISITANTE,
          validFromDate: '2026-12-01',
          validUntilDate: '2026-11-01',
        },
        internal,
        now,
      ).errors?.validUntil,
    ).toMatch(/vigência final/);
    const external = { type: 'EXTERNAL' as const, expiresAt: '2026-11-30T23:59:59.000Z' };
    expect(
      validateAssign(
        { ...EMPTY_ASSIGN_FORM, roleId: AUDITOR, validUntilDate: '2026-12-15' },
        external,
        now,
      ).errors?.validUntil,
    ).toMatch(/validade do vínculo/);
    expect(
      validateAssign(
        { ...EMPTY_ASSIGN_FORM, roleId: AUDITOR, validUntilDate: '2026-11-15' },
        external,
        now,
      ).body,
    ).toMatchObject({ roleId: AUDITOR, scopeType: 'TENANT' });
  });

  it('fase derivada das datas', () => {
    expect(assignmentPhase({ validFrom: '2026-12-01T00:00:00Z', validUntil: null }, now)).toBe(
      'SCHEDULED',
    );
    expect(
      assignmentPhase(
        { validFrom: '2026-01-01T00:00:00Z', validUntil: '2026-02-01T00:00:00Z' },
        now,
      ),
    ).toBe('ENDED');
    expect(assignmentPhase({ validFrom: '2026-01-01T00:00:00Z', validUntil: null }, now)).toBe(
      'EFFECTIVE',
    );
  });
});

/** Abre um `Select`/`Combobox` do kit pelo nome e escolhe a opção. */
const pick = async (
  user: ReturnType<typeof userEvent.setup>,
  scope: HTMLElement,
  field: string,
  option: string | RegExp,
) => {
  await user.click(within(scope).getByRole('combobox', { name: field }));
  await user.click(await screen.findByRole('option', { name: option }));
};

describe('Aba "Atribuições" (SCR-029 · US-096)', () => {
  it('lista perfil, escopo, vigência e quem concedeu; sem ROLE_ASSIGN não mostra ações', async () => {
    mockApi({
      list: () => jsonResponse({ data: [assignment()], meta: { canAssign: false, isSelf: false } }),
    });
    open();
    const table = await screen.findByRole('table', { name: 'Perfis atribuídos' });
    const card = within(table).getByRole('row', { name: /Requisitante/ });
    expect(card.textContent).toContain('Requisitante');
    expect(card.textContent).toContain('Unidade — Secretaria de Obras');
    expect(card.textContent).toContain('com subunidades');
    expect(card.textContent).toContain('Carla Souza');
    expect(screen.queryByRole('button', { name: 'Atribuir perfil' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Ações do perfil/ })).toBeNull();
  });

  it('estado vazio', async () => {
    mockApi({ list: () => jsonResponse({ data: [], meta: { canAssign: true, isSelf: false } }) });
    open();
    expect(await screen.findByText('Nenhum perfil atribuído.')).toBeTruthy();
  });

  it('atribui com escopo de unidade: valida, envia com Idempotency-Key, avisa e recarrega', async () => {
    const user = userEvent.setup();
    const api = mockApi();
    open();
    await user.click(await screen.findByRole('button', { name: 'Atribuir perfil' }));
    const dialog = await screen.findByRole('dialog');
    const roleSelect = within(dialog).getByRole('combobox', { name: 'Perfil' });
    expect(document.activeElement).toBe(roleSelect);

    // V-02: escopo de unidade sem unidade.
    await pick(user, dialog, 'Perfil', 'Requisitante');
    await pick(user, dialog, 'Escopo', 'Unidade');
    await user.click(within(dialog).getByRole('button', { name: 'Atribuir' }));
    expect(await within(dialog).findByText('Informe a unidade para este escopo.')).toBeTruthy();
    expect(callsOf(api, 'POST', '/role-assignments')).toHaveLength(0);

    await user.click(within(dialog).getByRole('combobox', { name: 'Unidade' }));
    await user.click(await screen.findByRole('option', { name: 'Secretaria de Obras' }));
    expect(
      within(dialog)
        .getByRole('checkbox', { name: /Incluir subárvore/ })
        .getAttribute('aria-checked'),
    ).toBe('true');
    expect(await seriousA11yViolations()).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Atribuir' }));

    expect(await screen.findByText('Perfil atribuído: Auditor.')).toBeTruthy();
    const [call] = callsOf(api, 'POST', `/users/${USER_ID}/role-assignments`);
    expect(call?.body).toEqual({
      roleId: REQUISITANTE,
      scopeType: 'DEPARTMENT',
      scopeDepartmentId: OBRAS,
      includeSubtree: true,
    });
    expect(call?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => {
      expect(callsOf(api, 'GET', `/users/${USER_ID}/role-assignments`).length).toBeGreaterThan(1);
    });
  });

  it('FA-03: vínculo externo só habilita perfis permitidos a externos', async () => {
    const user = userEvent.setup();
    mockApi();
    open(member({ type: 'EXTERNAL', expiresAt: '2099-12-31T23:59:59.000Z' }));
    await user.click(await screen.findByRole('button', { name: 'Atribuir perfil' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('combobox', { name: 'Perfil' }));
    const auditor = await screen.findByRole('option', { name: 'Auditor' });
    expect(auditor.getAttribute('aria-disabled')).toBeNull();
    const blocked = screen.getByRole('option', { name: /Requisitante — não permitido/ });
    expect(blocked.getAttribute('aria-disabled')).toBe('true');
    expect(blocked.getAttribute('title')).toBe(
      'Este perfil não pode ser atribuído a um vínculo externo.',
    );
  });

  it('erros da API: anti-escalonamento no diálogo e 422 por campo', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    mockApi({
      assign: () => {
        attempt += 1;
        return attempt === 1
          ? problemResponse(
              403,
              'PRIVILEGE_ESCALATION_FORBIDDEN',
              'Você não pode atribuir um perfil com permissões que não possui.',
            )
          : problemResponse(422, 'VALIDATION_ERROR', 'Revise os campos destacados.', [
              {
                field: 'roleId',
                code: 'REFERENCE_INACTIVE',
                message: 'Selecione um perfil válido.',
              },
            ]);
      },
    });
    open();
    await user.click(await screen.findByRole('button', { name: 'Atribuir perfil' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('combobox', { name: 'Perfil' });
    await pick(user, dialog, 'Perfil', 'Administrador do órgão');
    await user.click(within(dialog).getByRole('button', { name: 'Atribuir' }));
    expect(
      await within(dialog).findByText(
        'Você não pode atribuir um perfil com permissões que não possui.',
      ),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Atribuir' }));
    expect(await within(dialog).findByText('Selecione um perfil válido.')).toBeTruthy();
  });

  it('revoga com motivo e If-Match; último administrador (POL-12) fica no diálogo com a sugestão', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const api = mockApi({
      revoke: () => {
        attempt += 1;
        return attempt === 1
          ? problemResponse(
              409,
              'LAST_ADMIN_REQUIRED',
              'É preciso manter ao menos um administrador ativo.',
            )
          : jsonResponse({ data: assignment({ status: 'REVOKED', version: 2 }) });
      },
    });
    open();
    await user.click(await screen.findByRole('button', { name: 'Ações do perfil Requisitante' }));
    await user.click(
      await screen.findByRole('menuitem', { name: 'Revogar o perfil Requisitante' }),
    );
    const dialog = await screen.findByRole('alertdialog');
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Motivo (opcional)' }),
      'Mudou de setor',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Revogar perfil' }));
    expect(
      await within(dialog).findByText('É preciso manter ao menos um administrador ativo.'),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(/Atribua o perfil Administrador do órgão a outra pessoa/),
    ).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: 'Revogar perfil' }));
    expect(await screen.findByText('Perfil revogado: Requisitante.')).toBeTruthy();
    const calls = callsOf(api, 'POST', '/role-assignments/');
    expect(calls.at(-1)?.body).toEqual({ reason: 'Mudou de setor' });
    expect(calls.at(-1)?.headers.get('If-Match')).toBe('"1"');
  });

  it('FA-05: a própria última atribuição administrativa é avisada sem chamar a API', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      list: () =>
        jsonResponse({
          data: [
            assignment({
              roleName: 'Administrador do órgão',
              isAdministrative: true,
              scopeType: 'TENANT',
              scopeName: null,
              scopeDepartmentId: null,
            }),
          ],
          meta: { canAssign: true, isSelf: true },
        }),
    });
    open();
    await user.click(
      await screen.findByRole('button', { name: 'Ações do perfil Administrador do órgão' }),
    );
    await user.click(
      await screen.findByRole('menuitem', { name: 'Revogar o perfil Administrador do órgão' }),
    );
    expect(
      await screen.findByText('Você não pode remover seu próprio último perfil administrativo.'),
    ).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(callsOf(api, 'POST', '/role-assignments/')).toHaveLength(0);
  });

  it('erro ao carregar oferece tentar novamente; 403 explica a falta de permissão', async () => {
    mockApi({ list: () => problemResponse(403, 'PERMISSION_DENIED', 'x') });
    open();
    expect(
      await screen.findByText('Você não tem permissão para ver os perfis deste usuário.'),
    ).toBeTruthy();
  });
});
