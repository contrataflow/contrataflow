// @vitest-environment jsdom
import type { OrganizationDto } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { OrganizationsView } from './organizations-view';
import { StructureView } from './structure-view';

// A suíte completa roda em paralelo com as demais; o padrão de 1 s é curto para a primeira renderização.
configure({ asyncUtilTimeout: 5000 });
// Formulários longos digitados campo a campo: a suíte completa roda em paralelo e fica lenta.
vi.setConfig({ testTimeout: 30_000 });

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => '/admin/estrutura',
}));

let sequence = 0;
function organization(overrides: Partial<OrganizationDto>): OrganizationDto {
  sequence += 1;
  return {
    id: `0192a000-0000-7000-8000-${String(sequence).padStart(12, '0')}`,
    name: 'Prefeitura Municipal de São José',
    shortName: 'PMSJ',
    cnpj: '11222333000181',
    type: 'DIRECT_ADMINISTRATION',
    isActive: true,
    isPrimary: false,
    email: null,
    phone: null,
    website: null,
    addressStreet: null,
    addressNumber: null,
    addressComplement: null,
    addressDistrict: null,
    addressCity: null,
    addressState: null,
    addressZipCode: null,
    ibgeCityCode: null,
    logoAttachmentId: null,
    metadata: {},
    createdAt: '2026-10-15T12:00:00.000Z',
    updatedAt: '2026-10-15T12:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

const PMSJ = organization({ isPrimary: true });
const FMS = organization({
  name: 'Fundo Municipal de Saúde',
  shortName: 'FMS',
  cnpj: '11444777000161',
  type: 'FUND',
  version: 3,
});
const INATIVO = organization({
  name: 'Autarquia de Trânsito',
  shortName: 'AMT',
  cnpj: '45997418000153',
  type: 'AUTARCHY',
  isActive: false,
});
const CATALOG = [PMSJ, FMS, INATIVO];

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
      instance: '/api/v1/organizations',
      code,
      correlationId: 'c-test',
      errors,
      violations: [],
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function mockApi(
  routes: { list?: Handler; get?: Handler; post?: Handler; patch?: Handler } = {},
  permissions: readonly string[] = ['ORGANIZATION_MANAGE'],
) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/v1/me/permissions')) {
      return Promise.resolve(
        jsonResponse({
          data: { permissions: permissions.map((code) => ({ code, scopes: [] })) },
        }),
      );
    }
    if (method === 'GET' && url.startsWith('/api/v1/organizations?')) {
      return Promise.resolve(
        (routes.list ?? (() => jsonResponse({ data: CATALOG, meta: { page: 1 } })))(url, init),
      );
    }
    if (method === 'GET' && url.startsWith('/api/v1/organizations/')) {
      return Promise.resolve(
        (routes.get ?? (() => problemResponse(404, 'NOT_FOUND', 'x')))(url, init),
      );
    }
    if (method === 'POST' && url === '/api/v1/organizations') {
      return Promise.resolve(
        (routes.post ?? (() => problemResponse(500, 'INTERNAL_ERROR', 'x')))(url, init),
      );
    }
    if (method === 'PATCH') {
      return Promise.resolve(
        (routes.patch ?? (() => problemResponse(500, 'INTERNAL_ERROR', 'x')))(url, init),
      );
    }
    return Promise.resolve(problemResponse(404, 'NOT_FOUND', 'x'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const bodyOf = (init?: RequestInit): Record<string, unknown> =>
  JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;

const callsTo = (api: ReturnType<typeof mockApi>, method: string) =>
  api.mock.calls.filter(([, init]) => (init?.method ?? 'GET') === method);

function callOf(api: ReturnType<typeof mockApi>, method: string, index = 0) {
  const call = callsTo(api, method)[index];
  if (!call) throw new Error(`sem chamada ${method} #${String(index)}`);
  const headers = new Headers(call[1]?.headers);
  return { url: requestUrl(call[0]), init: call[1], headers };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Ação da linha no menu ⋯ (prd-5 · regra 3). */
async function rowAction(name: string, action: string) {
  await userEvent.click(await screen.findByRole('button', { name: `Ações de ${name}` }));
  await userEvent.click(await screen.findByRole('menuitem', { name: action }));
}

/** Escolhe uma opção no `Select` do kit (Radix): abre o gatilho e clica na opção. */
async function choose(trigger: HTMLElement, option: string) {
  await userEvent.click(trigger);
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

describe('[Sucesso] SCR-032 · aba Órgãos', () => {
  it('lista nome, sigla, CNPJ mascarado, tipo, situação e o selo "Principal"; sem violações de a11y', async () => {
    const api = mockApi();
    renderWithShell(<StructureView />);

    expect(await screen.findByRole('heading', { name: 'Estrutura organizacional' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Órgãos' }).getAttribute('aria-selected')).toBe('true');
    const table = await screen.findByRole('table', { name: 'Órgãos e entidades da instituição' });
    expect(
      api.mock.calls.some(([url]) => requestUrl(url).startsWith('/api/v1/organizations?')),
    ).toBe(true);

    const principal = within(table).getByRole('row', { name: /Prefeitura Municipal de São José/ });
    expect(within(principal).getByText('PMSJ')).toBeTruthy();
    expect(within(principal).getByText('11.222.333/0001-81')).toBeTruthy();
    expect(within(principal).getByText('Administração direta')).toBeTruthy();
    expect(within(principal).getByText('Principal')).toBeTruthy();
    const inactive = within(table).getByRole('row', { name: /Autarquia de Trânsito/ });
    expect(within(inactive).getByText('Inativo')).toBeTruthy();
    // As ações aparecem quando ME-03 confirma `ORGANIZATION_MANAGE`.
    expect(
      await within(inactive).findByRole('button', { name: 'Ações de Autarquia de Trânsito' }),
    ).toBeTruthy();
    await userEvent.click(
      within(principal).getByRole('button', { name: 'Ações de Prefeitura Municipal de São José' }),
    );
    expect(await screen.findByRole('menuitem', { name: 'Inativar' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Reativar' })).toBeNull();
    await userEvent.keyboard('{Escape}');
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('busca e filtros (no navegador): busca por sigla, situação e tipo com chips removíveis', async () => {
    mockApi();
    renderWithShell(<OrganizationsView />);
    const table = await screen.findByRole('table', { name: 'Órgãos e entidades da instituição' });
    await userEvent.type(screen.getByRole('searchbox', { name: 'Buscar' }), 'fms');
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByText('Fundo Municipal de Saúde')).toBeTruthy();
    await userEvent.clear(screen.getByRole('searchbox', { name: 'Buscar' }));

    await userEvent.click(screen.getByRole('button', { name: 'Filtros' }));
    await choose(await screen.findByRole('combobox', { name: 'Situação' }), 'Inativos');
    await userEvent.keyboard('{Escape}');
    expect(
      screen.getByRole('button', { name: 'Remover o filtro Situação: Inativos' }),
    ).toBeTruthy();
    const filtered = screen.getByRole('table', { name: 'Órgãos e entidades da instituição' });
    expect(within(filtered).getAllByRole('row')).toHaveLength(2);
    expect(within(filtered).getByText('Autarquia de Trânsito')).toBeTruthy();

    await userEvent.type(screen.getByRole('searchbox', { name: 'Buscar' }), 'zzz');
    expect(await screen.findByText('Nenhum órgão encontrado')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Limpar busca e filtros' }));
    expect(
      await screen.findByRole('table', { name: 'Órgãos e entidades da instituição' }),
    ).toBeTruthy();
  });

  it('estado de carregamento acessível e estado vazio', async () => {
    mockApi({ list: () => new Promise<Response>(() => undefined) });
    const first = renderWithShell(<OrganizationsView />);
    expect((await screen.findByRole('status')).textContent).toContain('Carregando os órgãos');
    first.unmount();

    mockApi({ list: () => jsonResponse({ data: [], meta: { page: 1 } }) });
    renderWithShell(<OrganizationsView />);
    expect(await screen.findByText('Nenhum órgão cadastrado')).toBeTruthy();
  });

  it('criar órgão: máscara no CNPJ, corpo de ORG-02 e lista relida', async () => {
    const created = organization({
      name: 'Fundo de Assistência',
      shortName: 'FAS',
      cnpj: '33000167000101',
      type: 'FUND',
    });
    const api = mockApi({
      post: () => jsonResponse({ data: created }, { status: 201, headers: { ETag: '"1"' } }),
    });
    renderWithShell(<OrganizationsView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Novo órgão' }));
    const dialog = await screen.findByRole('dialog', { name: 'Novo órgão' });

    const name = within(dialog).getByLabelText('Nome *');
    expect(document.activeElement).toBe(name);
    await userEvent.type(name, 'Fundo de Assistência');
    await userEvent.type(within(dialog).getByLabelText('Sigla *'), 'fas');
    const cnpj = within(dialog).getByLabelText<HTMLInputElement>('CNPJ *');
    await userEvent.type(cnpj, '33000167000101');
    expect(cnpj.value).toBe('33.000.167/0001-01');
    await choose(within(dialog).getByRole('combobox', { name: 'Tipo *' }), 'Fundo');
    await userEvent.type(within(dialog).getByLabelText('Site'), 'https://fas.sj.gov.br');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => {
      expect(callsTo(api, 'POST')).toHaveLength(1);
    });
    expect(bodyOf(callOf(api, 'POST').init)).toEqual({
      name: 'Fundo de Assistência',
      shortName: 'fas',
      cnpj: '33.000.167/0001-01',
      type: 'FUND',
      website: 'https://fas.sj.gov.br',
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    // A lista é invalidada e relida depois do 201 (o órgão novo aparece nos seletores).
    await waitFor(() => {
      expect(
        api.mock.calls.filter(([url]) => requestUrl(url).startsWith('/api/v1/organizations?'))
          .length,
      ).toBeGreaterThan(1);
    });
  });

  it('editar: envia só o que mudou, com If-Match da versão lida (ORG-04)', async () => {
    const api = mockApi({
      patch: () =>
        jsonResponse(
          { data: { ...FMS, phone: '4833810000', version: 4 } },
          { status: 200, headers: { ETag: '"4"' } },
        ),
    });
    renderWithShell(<OrganizationsView />);
    await rowAction('Fundo Municipal de Saúde', 'Editar');
    const dialog = await screen.findByRole('dialog', { name: 'Editar Fundo Municipal de Saúde' });
    await userEvent.type(within(dialog).getByLabelText('Telefone'), '4833810000');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => {
      expect(callsTo(api, 'PATCH')).toHaveLength(1);
    });
    const patch = callOf(api, 'PATCH');
    expect(patch.url).toBe(`/api/v1/organizations/${FMS.id}`);
    expect(patch.headers.get('If-Match')).toBe('"3"');
    expect(bodyOf(patch.init)).toEqual({ phone: '4833810000' });
  });

  it('inativar (FA-03): confirma e envia isActive=false; reativar é direto', async () => {
    const api = mockApi({
      patch: () => jsonResponse({ data: { ...FMS, isActive: false, version: 4 } }),
    });
    renderWithShell(<OrganizationsView />);
    await rowAction('Fundo Municipal de Saúde', 'Inativar');
    const dialog = await screen.findByRole('dialog', {
      name: 'Inativar Fundo Municipal de Saúde?',
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Inativar' }));
    await waitFor(() => {
      expect(callsTo(api, 'PATCH')).toHaveLength(1);
    });
    expect(bodyOf(callOf(api, 'PATCH').init)).toEqual({ isActive: false });

    await rowAction('Autarquia de Trânsito', 'Reativar');
    await waitFor(() => {
      expect(callsTo(api, 'PATCH')).toHaveLength(2);
    });
    expect(callOf(api, 'PATCH', 1).url).toBe(`/api/v1/organizations/${INATIVO.id}`);
    expect(bodyOf(callOf(api, 'PATCH', 1).init)).toEqual({ isActive: true });
  });
});

describe('[Validação] criação de órgão', () => {
  async function openCreate(post?: Handler) {
    const api = mockApi(post ? { post } : {});
    renderWithShell(<OrganizationsView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Novo órgão' }));
    const dialog = await screen.findByRole('dialog', { name: 'Novo órgão' });
    return { api, dialog };
  }

  it('obrigatórios em branco: "Informe o campo …" e nada é enviado', async () => {
    const { api, dialog } = await openCreate();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(await within(dialog).findByText('Informe o campo nome.')).toBeTruthy();
    expect(within(dialog).getByText('Informe o campo sigla.')).toBeTruthy();
    expect(within(dialog).getByText('Informe o campo cnpj.')).toBeTruthy();
    expect(within(dialog).getByText('Informe o campo tipo.')).toBeTruthy();
    expect(callsTo(api, 'POST')).toHaveLength(0);
  });

  it('CNPJ com dígito verificador inválido: erro ao sair do campo e no envio', async () => {
    const { api, dialog } = await openCreate();
    await userEvent.type(within(dialog).getByLabelText('Nome *'), 'Fundo Teste');
    await userEvent.type(within(dialog).getByLabelText('Sigla *'), 'FT');
    await userEvent.type(within(dialog).getByLabelText('CNPJ *'), '11111111111100');
    await choose(within(dialog).getByRole('combobox', { name: 'Tipo *' }), 'Fundo');
    await userEvent.tab();
    expect(await within(dialog).findByText('Informe um CNPJ válido.')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => {
      expect(within(dialog).getAllByText(/CNPJ|dígitos verificadores/).length).toBeGreaterThan(0);
    });
    expect(callsTo(api, 'POST')).toHaveLength(0);
  });

  it('erros do servidor por campo: sigla repetida e CNPJ repetido', async () => {
    const { api, dialog } = await openCreate(() =>
      problemResponse(422, 'VALIDATION_ERROR', 'Revise os campos destacados.', [
        {
          field: 'shortName',
          code: 'INVALID_FORMAT',
          message: 'Use 2 a 30 letras, números ou hífen, sem repetir uma sigla existente.',
        },
        { field: 'cnpj', code: 'INVALID_CNPJ', message: 'Já existe um órgão com este CNPJ.' },
      ]),
    );
    await userEvent.type(within(dialog).getByLabelText('Nome *'), 'Fundo Teste');
    await userEvent.type(within(dialog).getByLabelText('Sigla *'), 'PMSJ');
    await userEvent.type(within(dialog).getByLabelText('CNPJ *'), '11222333000181');
    await choose(within(dialog).getByRole('combobox', { name: 'Tipo *' }), 'Fundo');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    expect(await within(dialog).findByText('Já existe um órgão com este CNPJ.')).toBeTruthy();
    expect(within(dialog).getByText(/sem repetir uma sigla existente/)).toBeTruthy();
    expect(callsTo(api, 'POST')).toHaveLength(1);
  });

  it('banco indisponível (503): mensagem e o formulário continua aberto', async () => {
    const { dialog } = await openCreate(() =>
      problemResponse(503, 'DEPENDENCY_UNAVAILABLE', 'Serviço indisponível.'),
    );
    await userEvent.type(within(dialog).getByLabelText('Nome *'), 'Fundo Teste');
    await userEvent.type(within(dialog).getByLabelText('Sigla *'), 'FT');
    await userEvent.type(within(dialog).getByLabelText('CNPJ *'), '11444777000161');
    await choose(within(dialog).getByRole('combobox', { name: 'Tipo *' }), 'Fundo');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(
      await within(dialog).findByText('Não foi possível salvar agora. Tente novamente.'),
    ).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('[Regra RN-TEN-41] inativar o órgão principal ou o único ativo', () => {
  it('409 PRIMARY_ORGANIZATION_REQUIRED: o diálogo explica o motivo e sugere ativar outro órgão', async () => {
    mockApi({
      patch: () =>
        problemResponse(
          409,
          'PRIMARY_ORGANIZATION_REQUIRED',
          'Este é o único órgão ativo e não pode ser inativado.',
        ),
    });
    renderWithShell(<OrganizationsView />);
    await rowAction('Prefeitura Municipal de São José', 'Inativar');
    const dialog = await screen.findByRole('dialog', {
      name: 'Inativar Prefeitura Municipal de São José?',
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Inativar' }));
    expect(
      await within(dialog).findByText('Este é o único órgão ativo e não pode ser inativado.'),
    ).toBeTruthy();
    expect(within(dialog).getByText('Ative outro órgão antes de inativar este.')).toBeTruthy();
  });
});

describe('[Concorrência] FA-05 — conflito de versão', () => {
  it('412: oferece recarregar e reaplicar; reenvia com a versão atual e só as minhas alterações', async () => {
    const fresh = { ...FMS, name: 'Fundo Municipal de Saúde (renomeado)', version: 4 };
    let attempts = 0;
    const api = mockApi({
      get: () => jsonResponse({ data: fresh }),
      patch: () => {
        attempts += 1;
        return attempts === 1
          ? problemResponse(412, 'VERSION_CONFLICT', 'Este órgão foi alterado por outra pessoa.')
          : jsonResponse({ data: { ...fresh, phone: '4833810000', version: 5 } });
      },
    });
    renderWithShell(<OrganizationsView />);
    await rowAction('Fundo Municipal de Saúde', 'Editar');
    const dialog = await screen.findByRole('dialog', { name: 'Editar Fundo Municipal de Saúde' });
    await userEvent.type(within(dialog).getByLabelText('Telefone'), '4833810000');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    expect(
      await within(dialog).findByText('Este órgão foi alterado por outra pessoa.'),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Recarregar e reaplicar minhas alterações' }),
    );
    await waitFor(() => {
      expect(within(dialog).queryByText('Este órgão foi alterado por outra pessoa.')).toBeNull();
    });
    expect(within(dialog).getByLabelText<HTMLInputElement>('Telefone').value).toBe('4833810000');
    expect(within(dialog).getByLabelText<HTMLInputElement>('Nome *').value).toBe(
      'Fundo Municipal de Saúde (renomeado)',
    );

    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => {
      expect(callsTo(api, 'PATCH')).toHaveLength(2);
    });
    const second = callOf(api, 'PATCH', 1);
    expect(second.headers.get('If-Match')).toBe('"4"');
    expect(bodyOf(second.init)).toEqual({ phone: '4833810000' });
  });
});

describe('[Permissão] ORGANIZATION_MANAGE', () => {
  it('sem a permissão, "Novo órgão" e as ações de linha ficam ocultos; a leitura continua', async () => {
    mockApi({}, []);
    renderWithShell(<OrganizationsView />);
    expect(
      await screen.findByRole('table', { name: 'Órgãos e entidades da instituição' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Novo órgão' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Ações de/ })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Ações' })).toBeNull();
  });

  it('403 na leitura: "Acesso negado" no lugar da lista', async () => {
    mockApi({ list: () => problemResponse(403, 'PERMISSION_DENIED', 'Você não tem permissão.') });
    renderWithShell(<OrganizationsView />);
    expect(await screen.findByText('Acesso negado')).toBeTruthy();
  });

  it('falha de carga oferece "Tentar novamente"', async () => {
    mockApi({ list: () => problemResponse(429, 'RATE_LIMITED', 'Muitas tentativas.') });
    renderWithShell(<OrganizationsView />);
    expect(await screen.findByText('Não foi possível carregar os órgãos.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeTruthy();
  });
});
