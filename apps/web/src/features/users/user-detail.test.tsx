// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import type { MembershipAction, TenantMembershipDetailDto } from '@contrataflow/validation';
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { TENANT_A, jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { validateDepartments, validateProfile } from './user-detail-model';
import { UserDetailView } from './user-detail-view';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

const USER_ID = '0192a000-0000-7000-9000-000000000001';
const COMPRAS = '0192a000-0000-7000-8000-0000000000c1';
const LICITACOES = '0192a000-0000-7000-8000-0000000000c2';
const MANAGER = ['USER_VIEW', 'USER_MANAGE'];
const ALL_ACTIONS: MembershipAction[] = ['UPDATE', 'UPDATE_DEPARTMENTS', 'SUSPEND', 'REVOKE'];

function member(overrides: Partial<TenantMembershipDetailDto> = {}): TenantMembershipDetailDto {
  return {
    id: '0192a000-0000-7000-8000-000000000001',
    userId: USER_ID,
    name: 'Diego Ramos',
    socialName: null,
    email: 'diego@exemplo.gov.br',
    type: 'INTERNAL',
    status: 'ACTIVE',
    jobTitle: 'Analista de Compras',
    registrationNumber: '12345',
    expiresAt: null,
    departmentIds: [COMPRAS, LICITACOES],
    primaryDepartmentId: COMPRAS,
    invitedAt: '2026-10-01T12:00:00.000Z',
    inviteExpiresAt: null,
    activatedAt: '2026-10-02T12:00:00.000Z',
    version: 3,
    departments: [
      { id: COMPRAS, name: 'Setor de Compras', isActive: true, isPrimary: true },
      { id: LICITACOES, name: 'Setor de Licitações', isActive: true, isPrimary: false },
    ],
    suspendedAt: null,
    suspensionReason: null,
    revokedAt: null,
    revocationReason: null,
    ...overrides,
  };
}

function detailResponse(
  data: TenantMembershipDetailDto,
  allowedActions: readonly MembershipAction[] = ALL_ACTIONS,
  isSelf = false,
): Response {
  return jsonResponse(
    { data, meta: { allowedActions, isSelf } },
    { headers: { ETag: `"${String(data.version)}"` } },
  );
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
      instance: `/api/v1/users/${USER_ID}`,
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
  get?: Handler;
  patch?: Handler;
  departments?: Handler;
  suspend?: Handler;
  reactivate?: Handler;
  revoke?: Handler;
}

function mockApi(routes: Routes = {}, permissions: readonly string[] = MANAGER) {
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
    const base = `/api/v1/users/${USER_ID}`;
    if (method === 'GET' && url === base)
      return respond(routes.get, () => detailResponse(member()));
    if (method === 'PATCH' && url === base) {
      return respond(routes.patch, () => detailResponse(member({ version: 4 })));
    }
    if (method === 'PUT' && url === `${base}/departments`) {
      return respond(routes.departments, () => detailResponse(member({ version: 4 })));
    }
    if (method === 'POST' && url === `${base}/suspend`) {
      return respond(routes.suspend, () =>
        detailResponse(member({ version: 4, status: 'SUSPENDED' }), ['REACTIVATE', 'UPDATE']),
      );
    }
    if (method === 'POST' && url === `${base}/reactivate`) {
      return respond(routes.reactivate, () => detailResponse(member({ version: 5 })));
    }
    if (method === 'POST' && url === `${base}/revoke`) {
      return respond(routes.revoke, () =>
        detailResponse(member({ version: 4, status: 'REVOKED' }), ['UPDATE']),
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

const open = () =>
  renderWithShell(
    <>
      <UserDetailView userId={USER_ID} />
      <Toaster />
    </>,
  );
const cargo = () => screen.findByRole<HTMLInputElement>('textbox', { name: 'Cargo ou função' });

describe('modelo do detalhe (RN-IAM-55/56)', () => {
  it('valida o perfil com os limites da API e envia só o que mudou', () => {
    const current = member();
    const unchanged = {
      jobTitle: 'Analista de Compras',
      registrationNumber: '12345',
      expiresDate: '',
    };
    expect(validateProfile(current, unchanged)).toEqual({ ok: true, data: {} });
    expect(validateProfile(current, { ...unchanged, jobTitle: '  Coordenador  ' })).toEqual({
      ok: true,
      data: { jobTitle: 'Coordenador' },
    });
    expect(validateProfile(current, { ...unchanged, registrationNumber: '' })).toEqual({
      ok: true,
      data: { registrationNumber: null },
    });
    const tooLong = validateProfile(current, { ...unchanged, jobTitle: 'x'.repeat(151) });
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) {
      expect(tooLong.errors.jobTitle).toBe('O cargo deve ter no máximo 150 caracteres.');
    }
  });

  it('bloqueia lista vazia e principal fora do conjunto', () => {
    expect(validateDepartments({ ids: [], primary: null })).toEqual({
      ok: false,
      errors: { departmentIds: 'Selecione ao menos uma lotação.' },
    });
    expect(validateDepartments({ ids: [COMPRAS], primary: LICITACOES })).toEqual({
      ok: false,
      errors: { primaryDepartmentId: 'A lotação principal deve estar entre as selecionadas.' },
    });
    expect(validateDepartments({ ids: [COMPRAS, LICITACOES], primary: LICITACOES }).ok).toBe(true);
  });
});

describe('SCR-029 · detalhe do usuário (US-092)', () => {
  it('mostra os dados globais somente leitura e foca o primeiro campo; sem violações de a11y', async () => {
    mockApi();
    open();
    const field = await cargo();
    expect(screen.getByRole('heading', { level: 1, name: 'Diego Ramos' })).toBeTruthy();
    expect(screen.getByText('diego@exemplo.gov.br')).toBeTruthy();
    expect(screen.getByText('Ativo')).toBeTruthy();
    expect(field.value).toBe('Analista de Compras');
    expect(document.activeElement).toBe(field);
    // Nome e e-mail não são campos editáveis (DEC-012).
    expect(screen.queryByRole('textbox', { name: /Nome|E-mail/ })).toBeNull();
    expect(screen.queryByLabelText('Validade do vínculo')).toBeNull();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('[Sucesso] edita o cargo: PATCH só com o que mudou, If-Match da versão, toast e lista invalidada', async () => {
    const api = mockApi({
      patch: () => detailResponse(member({ version: 4, jobTitle: 'Coordenador de Compras' })),
    });
    const user = userEvent.setup();
    const { queryClient } = open();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    const field = await cargo();
    const save = screen.getByRole('button', { name: 'Salvar' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await user.clear(field);
    await user.type(field, 'Coordenador de Compras');
    await user.click(save);

    await waitFor(() => {
      expect(callsOf(api, 'PATCH', `/users/${USER_ID}`)).toHaveLength(1);
    });
    const call = callsOf(api, 'PATCH', `/users/${USER_ID}`)[0];
    expect(call?.body).toEqual({ jobTitle: 'Coordenador de Compras' });
    expect(call?.headers.get('If-Match')).toBe('"3"');
    expect(await screen.findByText('Dados do vínculo de Diego Ramos atualizados.')).toBeTruthy();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['t', TENANT_A.id, 'users', 'list'] });
    // O detalhe vem da resposta (sem novo GET) e "Salvar" volta a ficar desabilitado.
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Salvar' }).disabled).toBe(true);
    });
    expect(
      callsOf(api, 'GET', `/users/${USER_ID}`).filter((c) => c.url.endsWith(USER_ID)),
    ).toHaveLength(1);
  });

  it('[Validação] cargo acima de 150 caracteres não chama a API e foca o campo', async () => {
    const api = mockApi();
    const user = userEvent.setup();
    open();
    const field = await cargo();
    fireEvent.change(field, { target: { value: 'x'.repeat(151) } });
    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByText('O cargo deve ter no máximo 150 caracteres.')).toBeTruthy();
    expect(document.activeElement).toBe(field);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(callsOf(api, 'PATCH', '/users/')).toHaveLength(0);
  });

  it('[Validação] 422 da API aparece no campo', async () => {
    mockApi({
      patch: () =>
        problemResponse(422, 'VALIDATION_ERROR', 'x', [
          { field: 'registrationNumber', code: 'TOO_LONG', message: 'A matrícula é inválida.' },
        ]),
    });
    const user = userEvent.setup();
    open();
    const field = await screen.findByRole('textbox', { name: 'Matrícula' });
    await user.type(field, '9');
    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByText('A matrícula é inválida.')).toBeTruthy();
    expect(document.activeElement).toBe(field);
  });

  it('vínculo EXTERNAL mostra e edita a validade (fim do dia local em ISO)', async () => {
    const api = mockApi({
      get: () =>
        detailResponse(member({ type: 'EXTERNAL', expiresAt: '2099-06-30T23:59:59.999Z' })),
    });
    const user = userEvent.setup();
    open();
    const date = await screen.findByLabelText<HTMLInputElement>('Validade do vínculo');
    await user.clear(date);
    await user.type(date, '2099-12-31');
    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => {
      expect(callsOf(api, 'PATCH', '/users/')).toHaveLength(1);
    });
    const expiresAt = callsOf(api, 'PATCH', '/users/')[0]?.body.expiresAt;
    expect(typeof expiresAt).toBe('string');
    const sent = new Date(String(expiresAt));
    expect([sent.getFullYear(), sent.getMonth(), sent.getDate(), sent.getHours()]).toEqual([
      2099, 11, 31, 23,
    ]);
  });

  it('[Sucesso] troca a lotação principal: PUT com o conjunto e a principal, If-Match', async () => {
    const api = mockApi({
      departments: () =>
        detailResponse(
          member({
            version: 4,
            primaryDepartmentId: LICITACOES,
            departments: [
              { id: LICITACOES, name: 'Setor de Licitações', isActive: true, isPrimary: true },
              { id: COMPRAS, name: 'Setor de Compras', isActive: true, isPrimary: false },
            ],
          }),
        ),
    });
    const user = userEvent.setup();
    open();
    const radio = await screen.findByRole('radio', {
      name: 'Lotação principal: Setor de Licitações',
    });
    expect(
      screen.getByRole<HTMLInputElement>('radio', {
        name: 'Lotação principal: Setor de Compras',
      }).checked,
    ).toBe(true);
    const save = screen.getByRole('button', { name: 'Salvar lotações' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await user.click(radio);
    await user.click(save);

    await waitFor(() => {
      expect(callsOf(api, 'PUT', '/departments')).toHaveLength(1);
    });
    const call = callsOf(api, 'PUT', '/departments')[0];
    expect(call?.body).toEqual({
      departmentIds: [COMPRAS, LICITACOES],
      primaryDepartmentId: LICITACOES,
    });
    expect(call?.headers.get('If-Match')).toBe('"3"');
    expect(await screen.findByText('Lotações de Diego Ramos atualizadas.')).toBeTruthy();
  });

  it('remover a principal passa a principal para a próxima lotação', async () => {
    const api = mockApi();
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Remover Setor de Compras' }));
    expect(
      screen.getByRole<HTMLInputElement>('radio', {
        name: 'Lotação principal: Setor de Licitações',
      }).checked,
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Salvar lotações' }));
    await waitFor(() => {
      expect(callsOf(api, 'PUT', '/departments')).toHaveLength(1);
    });
    expect(callsOf(api, 'PUT', '/departments')[0]?.body).toEqual({
      departmentIds: [LICITACOES],
      primaryDepartmentId: LICITACOES,
    });
  });

  it('[Validação] sem nenhuma lotação: "Selecione ao menos uma lotação." e a API não é chamada', async () => {
    const api = mockApi();
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Remover Setor de Compras' }));
    await user.click(screen.getByRole('button', { name: 'Remover Setor de Licitações' }));
    await user.click(screen.getByRole('button', { name: 'Salvar lotações' }));
    expect(await screen.findByText('Selecione ao menos uma lotação.')).toBeTruthy();
    expect(callsOf(api, 'PUT', '/departments')).toHaveLength(0);
  });

  it('[Permissão] sem USER_MANAGE (allowedActions vazio): só leitura e nenhum botão de edição', async () => {
    mockApi({ get: () => detailResponse(member(), []) }, ['USER_VIEW']);
    open();
    expect(await screen.findByRole('heading', { level: 1, name: 'Diego Ramos' })).toBeTruthy();
    expect(screen.getByText('Analista de Compras')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Lotações do vínculo' }).textContent).toContain(
      'Setor de Compras',
    );
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button', { name: /Salvar|Suspender|Reativar|Revogar/ })).toBeNull();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('[POL-16] no próprio vínculo, suspender e revogar ficam desabilitados com o aviso', async () => {
    mockApi({ get: () => detailResponse(member(), ['UPDATE', 'UPDATE_DEPARTMENTS'], true) });
    open();
    const suspend = await screen.findByRole<HTMLButtonElement>('button', {
      name: 'Suspender acesso',
    });
    const revoke = screen.getByRole<HTMLButtonElement>('button', { name: 'Revogar vínculo' });
    expect(suspend.disabled).toBe(true);
    expect(revoke.disabled).toBe(true);
    expect(suspend.getAttribute('title')).toBe('Você não pode remover o próprio acesso.');
    const note = screen.getByText('Você não pode remover o próprio acesso.', { selector: 'p' });
    expect(suspend.getAttribute('aria-describedby')).toBe(note.id);
    expect(revoke.getAttribute('aria-describedby')).toBe(note.id);
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('[Tenant incorreto] 404 mostra "Usuário não encontrado." com o caminho de volta à lista', async () => {
    mockApi({ get: () => problemResponse(404, 'USER_NOT_FOUND', 'x') });
    open();
    expect(await screen.findByText('Usuário não encontrado.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Voltar para usuários' }).getAttribute('href')).toBe(
      '/admin/usuarios',
    );
  });

  it('404 numa mutação volta à lista', async () => {
    mockApi({ patch: () => problemResponse(404, 'USER_NOT_FOUND', 'x') });
    const user = userEvent.setup();
    open();
    await user.type(await cargo(), '!');
    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByText('Usuário não encontrado.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Voltar para usuários' })).toBeTruthy();
  });

  it('carregando (skeleton), erro com "Tentar novamente" e 403', async () => {
    mockApi({ get: () => new Promise<Response>(() => undefined) });
    const loading = open();
    expect((await screen.findByRole('status')).textContent).toContain('Carregando o usuário');
    loading.unmount();

    mockApi({ get: () => problemResponse(403, 'PERMISSION_DENIED', 'x') }, []);
    const forbidden = open();
    expect(await screen.findByText('Você não tem acesso a esta área')).toBeTruthy();
    forbidden.unmount();

    let healthy = false;
    mockApi({
      get: () =>
        healthy ? detailResponse(member()) : problemResponse(400, 'MALFORMED_REQUEST', 'x'),
    });
    const user = userEvent.setup();
    open();
    expect(await screen.findByText('Não foi possível carregar o usuário.')).toBeTruthy();
    healthy = true;
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Diego Ramos' })).toBeTruthy();
  });

  it('[Concorrência] 412 mostra a mensagem, recarrega o detalhe e mostra os dados atuais', async () => {
    let reads = 0;
    const api = mockApi({
      get: () => {
        reads += 1;
        return reads === 1
          ? detailResponse(member())
          : detailResponse(member({ version: 5, jobTitle: 'Gerente de Compras' }));
      },
      patch: () => problemResponse(412, 'VERSION_CONFLICT', 'x'),
    });
    const user = userEvent.setup();
    open();
    const field = await cargo();
    await user.clear(field);
    await user.type(field, 'Meu cargo');
    await user.click(screen.getByRole('button', { name: 'Salvar' }));

    expect(
      await screen.findByText('Os dados foram alterados por outra pessoa. Recarregue.'),
    ).toBeTruthy();
    await waitFor(() => {
      expect(reads).toBe(2);
    });
    // O formulário recomeça do vínculo atual e a nova tentativa usa a versão nova.
    await waitFor(() => {
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Cargo ou função' }).value).toBe(
        'Gerente de Compras',
      );
    });
    await user.type(screen.getByRole('textbox', { name: 'Cargo ou função' }), '!');
    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => {
      expect(callsOf(api, 'PATCH', '/users/')).toHaveLength(2);
    });
    expect(callsOf(api, 'PATCH', '/users/')[1]?.headers.get('If-Match')).toBe('"5"');
  });

  it('[Falha de banco] 503 numa edição mantém os dados e oferece "Tentar novamente"', async () => {
    let attempts = 0;
    const api = mockApi({
      patch: () => {
        attempts += 1;
        return attempts === 1
          ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE', 'x')
          : detailResponse(member({ version: 4, jobTitle: 'Novo cargo' }));
      },
    });
    const user = userEvent.setup();
    open();
    const field = await cargo();
    await user.clear(field);
    await user.type(field, 'Novo cargo');
    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(
      await screen.findByText('Não foi possível concluir agora. Tente novamente.'),
    ).toBeTruthy();
    expect(field.value).toBe('Novo cargo');
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('Dados do vínculo de Diego Ramos atualizados.')).toBeTruthy();
    expect(callsOf(api, 'PATCH', '/users/')).toHaveLength(2);
  });

  it('MFA exigido leva ao step-up', async () => {
    mockApi({ patch: () => problemResponse(403, 'MFA_REQUIRED', 'x') });
    const user = userEvent.setup();
    open();
    await user.type(await cargo(), '!');
    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    const link = await screen.findByRole('link', { name: 'Confirmar identidade' });
    expect(link.getAttribute('href')).toBe(
      `/api/auth/step-up?returnTo=${encodeURIComponent(`/admin/usuarios/${USER_ID}`)}`,
    );
  });
});

describe('SCR-029 · suspender, reativar e revogar (US-092)', () => {
  const openSuspend = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole('button', { name: 'Suspender acesso' }));
    return screen.findByRole('alertdialog', { name: 'Suspender o acesso de Diego Ramos?' });
  };

  it('[Sucesso] suspende com motivo opcional (alertdialog, foco no motivo) e atualiza a tela', async () => {
    const api = mockApi({
      suspend: () =>
        detailResponse(
          member({
            version: 4,
            status: 'SUSPENDED',
            suspendedAt: '2026-10-16T12:00:00.000Z',
            suspensionReason: 'Afastamento',
          }),
          ['UPDATE', 'UPDATE_DEPARTMENTS', 'REACTIVATE', 'REVOKE'],
        ),
    });
    const user = userEvent.setup();
    const { queryClient } = open();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const dialog = await openSuspend(user);
    const reason = within(dialog).getByRole('textbox', { name: 'Motivo (opcional)' });
    expect(document.activeElement).toBe(reason);
    expect(await seriousA11yViolations()).toEqual([]);
    await user.type(reason, 'Afastamento');
    await user.click(within(dialog).getByRole('button', { name: 'Suspender acesso' }));

    await waitFor(() => {
      expect(callsOf(api, 'POST', '/suspend')).toHaveLength(1);
    });
    const call = callsOf(api, 'POST', '/suspend')[0];
    expect(call?.body).toEqual({ reason: 'Afastamento' });
    expect(call?.headers.get('If-Match')).toBe('"3"');
    expect(await screen.findByText('Acesso de Diego Ramos suspenso.')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['t', TENANT_A.id, 'users', 'list'] });
    expect(screen.getByText('Suspenso', { selector: 'span' })).toBeTruthy();
    expect(screen.getByText('Motivo: Afastamento')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Suspender acesso' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reativar' })).toBeTruthy();
  });

  it('suspende sem motivo enviando corpo vazio; motivo acima de 500 não chama a API', async () => {
    const api = mockApi();
    const user = userEvent.setup();
    open();
    const dialog = await openSuspend(user);
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Motivo (opcional)' }), {
      target: { value: 'x'.repeat(501) },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Suspender acesso' }));
    expect(
      await within(dialog).findByText('O motivo deve ter no máximo 500 caracteres.'),
    ).toBeTruthy();
    expect(callsOf(api, 'POST', '/suspend')).toHaveLength(0);

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Motivo (opcional)' }), {
      target: { value: '' },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Suspender acesso' }));
    await waitFor(() => {
      expect(callsOf(api, 'POST', '/suspend')).toHaveLength(1);
    });
    expect(callsOf(api, 'POST', '/suspend')[0]?.body).toEqual({});
  });

  it('[Duplicidade] 409 INVALID_STATE mostra a mensagem e recarrega o detalhe com o status real', async () => {
    let reads = 0;
    mockApi({
      get: () => {
        reads += 1;
        return reads === 1
          ? detailResponse(member())
          : detailResponse(member({ version: 4, status: 'SUSPENDED' }), ['UPDATE', 'REACTIVATE']);
      },
      suspend: () =>
        problemResponse(
          409,
          'INVALID_STATE',
          'Esta ação não é válida para o status atual do vínculo.',
        ),
    });
    const user = userEvent.setup();
    open();
    const dialog = await openSuspend(user);
    await user.click(within(dialog).getByRole('button', { name: 'Suspender acesso' }));
    expect(
      await screen.findByText('Esta ação não é válida para o status atual do vínculo.'),
    ).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => {
      expect(reads).toBe(2);
    });
    expect(await screen.findByRole('button', { name: 'Reativar' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Suspender acesso' })).toBeNull();
  });

  it('[POL-12] 409 LAST_ADMIN_REQUIRED mantém o vínculo e sugere promover outro administrador', async () => {
    const api = mockApi({
      revoke: () =>
        problemResponse(
          409,
          'LAST_ADMIN_REQUIRED',
          'É preciso manter ao menos um administrador ativo.',
        ),
    });
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Revogar vínculo' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Revogar o vínculo de Diego Ramos?',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Revogar vínculo' }));
    expect(
      await within(dialog).findByText('É preciso manter ao menos um administrador ativo.'),
    ).toBeTruthy();
    expect(within(dialog).getByText(/Promova outro usuário a administrador/)).toBeTruthy();
    expect(callsOf(api, 'POST', '/revoke')).toHaveLength(1);
    // O diálogo continua aberto e o status não mudou.
    expect(screen.getByText('Ativo')).toBeTruthy();
  });

  it('[POL-16] 403 da API (UI contornada) mostra "Você não pode remover o próprio acesso."', async () => {
    mockApi({
      suspend: () =>
        problemResponse(403, 'PERMISSION_DENIED', 'Você não pode remover o próprio acesso.'),
    });
    const user = userEvent.setup();
    open();
    const dialog = await openSuspend(user);
    await user.click(within(dialog).getByRole('button', { name: 'Suspender acesso' }));
    expect(await within(dialog).findByText('Você não pode remover o próprio acesso.')).toBeTruthy();
  });

  it('[Falha de banco] 503 ao revogar mantém o diálogo com "Tentar novamente"; revogar avisa da irreversibilidade', async () => {
    let attempts = 0;
    const api = mockApi({
      revoke: () => {
        attempts += 1;
        return attempts === 1
          ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE', 'x')
          : detailResponse(
              member({
                version: 4,
                status: 'REVOKED',
                revokedAt: '2026-10-16T12:00:00.000Z',
                revocationReason: null,
              }),
              ['UPDATE'],
            );
      },
    });
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Revogar vínculo' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Revogar o vínculo de Diego Ramos?',
    });
    expect(within(dialog).getByText(/irreversível/)).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Revogar vínculo' }));
    expect(
      await within(dialog).findByText('Não foi possível concluir agora. Tente novamente.'),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('Vínculo de Diego Ramos revogado.')).toBeTruthy();
    expect(callsOf(api, 'POST', '/revoke')).toHaveLength(2);
    expect(screen.getByText('Revogado', { selector: 'span' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Suspender|Revogar vínculo/ })).toBeNull();
  });

  it('[Sucesso] reativa um vínculo suspenso (POST vazio com If-Match)', async () => {
    const api = mockApi({
      get: () =>
        detailResponse(member({ status: 'SUSPENDED', suspendedAt: '2026-10-10T12:00:00.000Z' }), [
          'UPDATE',
          'UPDATE_DEPARTMENTS',
          'REACTIVATE',
          'REVOKE',
        ]),
    });
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Reativar' }));
    await waitFor(() => {
      expect(callsOf(api, 'POST', '/reactivate')).toHaveLength(1);
    });
    const call = callsOf(api, 'POST', '/reactivate')[0];
    expect(call?.body).toEqual({});
    expect(call?.headers.get('If-Match')).toBe('"3"');
    expect(await screen.findByText('Acesso de Diego Ramos reativado.')).toBeTruthy();
    expect(screen.getByText('Ativo')).toBeTruthy();
  });

  it('sem motivo na tela, Cancelar fecha o diálogo sem chamar a API', async () => {
    const api = mockApi();
    const user = userEvent.setup();
    open();
    const dialog = await openSuspend(user);
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect(callsOf(api, 'POST', '/suspend')).toHaveLength(0);
  });
});
