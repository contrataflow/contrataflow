// @vitest-environment jsdom
import type { SupplierDto } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { SuppliersView } from './suppliers-view';

// A suíte completa roda em paralelo com as demais; o padrão de 1 s é curto para a primeira renderização.
configure({ asyncUtilTimeout: 5000 });
// Formulários longos digitados campo a campo: a suíte completa roda em paralelo e fica lenta.
vi.setConfig({ testTimeout: 30_000 });

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => '/fornecedores',
}));

let sequence = 0;
function supplier(overrides: Partial<SupplierDto>): SupplierDto {
  sequence += 1;
  return {
    id: `0192a000-0000-7000-8000-${String(sequence).padStart(12, '0')}`,
    documentType: 'CNPJ',
    documentNumber: '11222333000181',
    legalName: 'Construtora ABC Ltda',
    tradeName: null,
    email: null,
    phone: null,
    website: null,
    contactName: null,
    addressStreet: null,
    addressNumber: null,
    addressComplement: null,
    addressDistrict: null,
    addressCity: null,
    addressState: null,
    addressZipCode: null,
    isActive: true,
    notes: null,
    createdAt: '2026-10-16T12:00:00.000Z',
    updatedAt: '2026-10-16T12:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

const ABC = supplier({ tradeName: 'ABC Obras', email: 'contato@abc.com.br' });
const JOAO = supplier({
  documentType: 'CPF',
  documentNumber: '***.444.777-**',
  legalName: 'João da Silva',
  version: 3,
});
const ACME = supplier({
  documentType: 'FOREIGN',
  documentNumber: 'DE-123456789',
  legalName: 'Acme GmbH',
  isActive: false,
});
const CATALOG = [ABC, JOAO, ACME];

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
      instance: '/api/v1/suppliers',
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
  routes: {
    list?: Handler;
    lookup?: Handler;
    get?: Handler;
    post?: Handler;
    patch?: Handler;
    delete?: Handler;
  } = {},
  permissions: readonly string[] = ['SUPPLIER_VIEW', 'SUPPLIER_MANAGE'],
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
    if (method === 'GET' && url.startsWith('/api/v1/suppliers/lookup')) {
      return Promise.resolve((routes.lookup ?? (() => jsonResponse({ data: null })))(url, init));
    }
    if (method === 'GET' && url.startsWith('/api/v1/suppliers?')) {
      return Promise.resolve(
        (
          routes.list ??
          (() => jsonResponse({ data: CATALOG, meta: { page: 1, totalPages: 1, totalItems: 3 } }))
        )(url, init),
      );
    }
    if (method === 'GET' && url.startsWith('/api/v1/suppliers/')) {
      return Promise.resolve(
        (routes.get ?? (() => problemResponse(404, 'NOT_FOUND', 'x')))(url, init),
      );
    }
    if (method === 'POST' && url === '/api/v1/suppliers') {
      return Promise.resolve(
        (routes.post ?? (() => problemResponse(500, 'INTERNAL_ERROR', 'x')))(url, init),
      );
    }
    if (method === 'PATCH') {
      return Promise.resolve(
        (routes.patch ?? (() => problemResponse(500, 'INTERNAL_ERROR', 'x')))(url, init),
      );
    }
    if (method === 'DELETE') {
      return Promise.resolve(
        (routes.delete ?? (() => new Response(null, { status: 204 })))(url, init),
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

describe('[Sucesso] SCR-107 · lista de fornecedores', () => {
  it('lista razão social, documento (CNPJ mascarado, CPF mascarado pela API), contato e situação; sem violações de a11y', async () => {
    const api = mockApi();
    renderWithShell(<SuppliersView />);

    const table = await screen.findByRole('table', { name: 'Fornecedores da instituição' });
    expect(api.mock.calls.some(([url]) => requestUrl(url).startsWith('/api/v1/suppliers?'))).toBe(
      true,
    );
    const abc = within(table).getByRole('row', { name: /Construtora ABC Ltda/ });
    expect(within(abc).getByText('ABC Obras')).toBeTruthy();
    expect(within(abc).getByText('11.222.333/0001-81')).toBeTruthy();
    expect(within(abc).getByText('contato@abc.com.br')).toBeTruthy();
    const joao = within(table).getByRole('row', { name: /João da Silva/ });
    expect(within(joao).getByText('***.444.777-**')).toBeTruthy();
    expect(within(joao).getByText('CPF')).toBeTruthy();
    const acme = within(table).getByRole('row', { name: /Acme GmbH/ });
    expect(within(acme).getByText('Inativo')).toBeTruthy();
    expect(within(acme).getByText('DE-123456789')).toBeTruthy();
    expect(table.textContent).not.toContain('11144477735');
    // As ações aparecem quando ME-03 confirma `SUPPLIER_MANAGE`.
    expect(await within(acme).findByRole('button', { name: 'Reativar Acme GmbH' })).toBeTruthy();
    expect(within(abc).getByRole('button', { name: 'Excluir Construtora ABC Ltda' })).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('sem SUPPLIER_MANAGE: consulta sem ações de escrita', async () => {
    mockApi({}, ['SUPPLIER_VIEW']);
    renderWithShell(<SuppliersView />);
    const table = await screen.findByRole('table', { name: 'Fornecedores da instituição' });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Novo fornecedor' })).toBeNull();
    });
    expect(within(table).queryByRole('button', { name: /Editar|Inativar|Reativar|Excluir/ })).toBe(
      null,
    );
    expect(within(table).queryByRole('columnheader', { name: 'Ações' })).toBeNull();
  });

  it('estados: carregando, vazio, sem resultado, erro com "Tentar novamente" e 403', async () => {
    mockApi({ list: () => new Promise<Response>(() => undefined) });
    const first = renderWithShell(<SuppliersView />);
    expect((await screen.findByRole('status')).textContent).toContain('Carregando os fornecedores');
    first.unmount();

    mockApi({ list: () => jsonResponse({ data: [], meta: { page: 1 } }) });
    const second = renderWithShell(<SuppliersView />);
    expect(
      await screen.findByText('Nenhum fornecedor cadastrado. Cadastre o primeiro.'),
    ).toBeTruthy();
    second.unmount();

    mockApi({ list: () => problemResponse(500, 'INTERNAL_ERROR', 'falha') });
    const third = renderWithShell(<SuppliersView />);
    expect(await screen.findByText('Não foi possível carregar os fornecedores.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeTruthy();
    third.unmount();

    mockApi({ list: () => problemResponse(403, 'PERMISSION_DENIED', 'negado') });
    renderWithShell(<SuppliersView />);
    expect(await screen.findByText('Acesso negado')).toBeTruthy();
  });

  it('busca (≥ 2 caracteres, com debounce) e filtro Ativos/Inativos vão à API', async () => {
    const api = mockApi();
    renderWithShell(<SuppliersView />);
    await screen.findByRole('table', { name: 'Fornecedores da instituição' });

    await userEvent.type(screen.getByLabelText('Buscar'), 'a');
    await userEvent.selectOptions(screen.getByLabelText('Situação'), 'false');
    await waitFor(() => {
      expect(api.mock.calls.some(([url]) => requestUrl(url).includes('isActive=false'))).toBe(true);
    });
    expect(api.mock.calls.some(([url]) => requestUrl(url).includes('q='))).toBe(false);

    await userEvent.type(screen.getByLabelText('Buscar'), 'bc');
    await waitFor(() => {
      expect(
        api.mock.calls.some(
          ([url]) =>
            requestUrl(url).includes('q=abc') && requestUrl(url).includes('isActive=false'),
        ),
      ).toBe(true);
    });
  });

  it('criar fornecedor com CNPJ: máscara, Idempotency-Key e corpo de SUP-02; lista relida', async () => {
    const created = supplier({
      legalName: 'Nova Fornecedora SA',
      documentNumber: '33000167000101',
    });
    const api = mockApi({
      post: () => jsonResponse({ data: created }, { status: 201, headers: { ETag: '"1"' } }),
    });
    renderWithShell(<SuppliersView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Novo fornecedor' }));
    const dialog = await screen.findByRole('dialog', { name: 'Novo fornecedor' });

    const number = within(dialog).getByLabelText<HTMLInputElement>('Número do documento *');
    await userEvent.type(number, '33000167000101');
    expect(number.value).toBe('33.000.167/0001-01');
    await userEvent.type(
      within(dialog).getByLabelText('Razão social / Nome *'),
      'Nova Fornecedora SA',
    );
    await userEvent.type(within(dialog).getByLabelText('E-mail'), 'vendas@nova.com.br');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => {
      expect(callsTo(api, 'POST')).toHaveLength(1);
    });
    const post = callOf(api, 'POST');
    expect(bodyOf(post.init)).toEqual({
      documentType: 'CNPJ',
      documentNumber: '33.000.167/0001-01',
      legalName: 'Nova Fornecedora SA',
      email: 'vendas@nova.com.br',
    });
    expect(post.headers.get('Idempotency-Key')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(
        api.mock.calls.filter(([url]) => requestUrl(url).startsWith('/api/v1/suppliers?')).length,
      ).toBeGreaterThan(1);
    });
  });

  it('trocar para CPF muda a máscara; CPF e estrangeiro vão no corpo com o tipo escolhido', async () => {
    const api = mockApi({
      post: () => jsonResponse({ data: supplier({ documentType: 'CPF' }) }, { status: 201 }),
    });
    renderWithShell(<SuppliersView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Novo fornecedor' }));
    const dialog = await screen.findByRole('dialog', { name: 'Novo fornecedor' });

    await userEvent.selectOptions(within(dialog).getByLabelText('Tipo de documento *'), 'CPF');
    const number = within(dialog).getByLabelText<HTMLInputElement>('Número do documento *');
    await userEvent.type(number, '11144477735');
    expect(number.value).toBe('111.444.777-35');
    await userEvent.type(within(dialog).getByLabelText('Razão social / Nome *'), 'João da Silva');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => {
      expect(callsTo(api, 'POST')).toHaveLength(1);
    });
    expect(bodyOf(callOf(api, 'POST').init)).toMatchObject({
      documentType: 'CPF',
      documentNumber: '111.444.777-35',
    });
  });

  it('editar: documento bloqueado, só o que mudou vai no corpo com If-Match (SUP-04)', async () => {
    const api = mockApi({
      patch: () =>
        jsonResponse(
          { data: { ...JOAO, phone: '4833810000', version: 4 } },
          { status: 200, headers: { ETag: '"4"' } },
        ),
    });
    renderWithShell(<SuppliersView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Editar João da Silva' }));
    const dialog = await screen.findByRole('dialog', { name: 'Editar João da Silva' });

    const number = within(dialog).getByLabelText<HTMLInputElement>('Número do documento *');
    expect(number.value).toBe('***.444.777-**');
    expect(number.readOnly).toBe(true);
    expect(within(dialog).getByLabelText<HTMLSelectElement>('Tipo de documento *').disabled).toBe(
      true,
    );
    expect(
      within(dialog).getByText('Documento não pode ser alterado. Cadastre um novo fornecedor.'),
    ).toBeTruthy();

    await userEvent.type(within(dialog).getByLabelText('Telefone'), '4833810000');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => {
      expect(callsTo(api, 'PATCH')).toHaveLength(1);
    });
    const patch = callOf(api, 'PATCH');
    expect(patch.url).toBe(`/api/v1/suppliers/${JOAO.id}`);
    expect(patch.headers.get('If-Match')).toBe('"3"');
    expect(bodyOf(patch.init)).toEqual({ phone: '4833810000' });
  });

  it('inativar (FA-02): confirma e envia isActive=false; reativar é direto', async () => {
    const api = mockApi({
      patch: () => jsonResponse({ data: { ...ABC, isActive: false, version: 2 } }),
    });
    renderWithShell(<SuppliersView />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Inativar Construtora ABC Ltda' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Inativar Construtora ABC Ltda?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Inativar' }));
    await waitFor(() => {
      expect(callsTo(api, 'PATCH')).toHaveLength(1);
    });
    expect(bodyOf(callOf(api, 'PATCH').init)).toEqual({ isActive: false });

    await userEvent.click(screen.getByRole('button', { name: 'Reativar Acme GmbH' }));
    await waitFor(() => {
      expect(callsTo(api, 'PATCH')).toHaveLength(2);
    });
    expect(callOf(api, 'PATCH', 1).url).toBe(`/api/v1/suppliers/${ACME.id}`);
    expect(bodyOf(callOf(api, 'PATCH', 1).init)).toEqual({ isActive: true });
  });

  it('excluir (FA-03): confirma no diálogo e envia DELETE com If-Match', async () => {
    const api = mockApi();
    renderWithShell(<SuppliersView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Excluir João da Silva' }));
    const dialog = await screen.findByRole('dialog', { name: 'Excluir João da Silva?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Excluir' }));

    await waitFor(() => {
      expect(callsTo(api, 'DELETE')).toHaveLength(1);
    });
    const del = callOf(api, 'DELETE');
    expect(del.url).toBe(`/api/v1/suppliers/${JOAO.id}`);
    expect(del.headers.get('If-Match')).toBe('"3"');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('excluir fornecedor em uso (FA-04): mostra o motivo e oferece Inativar no lugar', async () => {
    const api = mockApi({
      delete: () =>
        problemResponse(
          409,
          'SUPPLIER_IN_USE',
          'Este fornecedor está em uso em pesquisas de preço e não pode ser excluído.',
        ),
      patch: () => jsonResponse({ data: { ...ABC, isActive: false, version: 2 } }),
    });
    renderWithShell(<SuppliersView />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Excluir Construtora ABC Ltda' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Excluir Construtora ABC Ltda?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Excluir' }));

    expect(
      await within(dialog).findByText(
        'Este fornecedor está em uso em pesquisas de preço e não pode ser excluído.',
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Excluir' })).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Inativar' }));
    await waitFor(() => {
      expect(callsTo(api, 'PATCH')).toHaveLength(1);
    });
    expect(bodyOf(callOf(api, 'PATCH').init)).toEqual({ isActive: false });
  });
});

describe('[Validação] criação de fornecedor', () => {
  async function openCreate(post?: Handler, lookup?: Handler) {
    const api = mockApi({ ...(post ? { post } : {}), ...(lookup ? { lookup } : {}) });
    renderWithShell(<SuppliersView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Novo fornecedor' }));
    const dialog = await screen.findByRole('dialog', { name: 'Novo fornecedor' });
    return { api, dialog };
  }

  it('obrigatórios em branco: "Informe o campo …" e nada é enviado', async () => {
    const { api, dialog } = await openCreate();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(await within(dialog).findByText('Informe o campo número do documento.')).toBeTruthy();
    expect(within(dialog).getByText('Informe o campo razão social / nome.')).toBeTruthy();
    expect(callsTo(api, 'POST')).toHaveLength(0);
  });

  it('CNPJ com dígito verificador inválido: erro ao sair do campo e no envio, sem chamar a API', async () => {
    const { api, dialog } = await openCreate();
    await userEvent.type(within(dialog).getByLabelText('Número do documento *'), '11222333000100');
    await userEvent.type(within(dialog).getByLabelText('Razão social / Nome *'), 'Inválida Ltda');
    expect(
      await within(dialog).findByText('CNPJ inválido. Verifique o número digitado.'),
    ).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => {
      expect(
        within(dialog).getAllByText('CNPJ inválido. Verifique o número digitado.').length,
      ).toBeGreaterThan(0);
    });
    expect(callsTo(api, 'POST')).toHaveLength(0);
    expect(
      api.mock.calls.some(([url]) => requestUrl(url).startsWith('/api/v1/suppliers/lookup')),
    ).toBe(false);
  });

  it('CPF com dígito verificador inválido', async () => {
    const { api, dialog } = await openCreate();
    await userEvent.selectOptions(within(dialog).getByLabelText('Tipo de documento *'), 'CPF');
    await userEvent.type(within(dialog).getByLabelText('Número do documento *'), '11144477700');
    await userEvent.tab();
    expect(
      await within(dialog).findByText('CPF inválido. Verifique o número digitado.'),
    ).toBeTruthy();
    expect(callsTo(api, 'POST')).toHaveLength(0);
  });

  it('documento já cadastrado: aviso antecipado pelo lookup (SUP-06) com o nome do fornecedor', async () => {
    const { dialog } = await openCreate(undefined, () => jsonResponse({ data: ABC }));
    await userEvent.type(within(dialog).getByLabelText('Número do documento *'), '11222333000181');
    await userEvent.tab();
    expect(
      await within(dialog).findByText(
        'Este documento já está cadastrado para Construtora ABC Ltda.',
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText('Já existe um fornecedor cadastrado com este documento.'),
    ).toBeTruthy();
  });

  it('409 SUPPLIER_ALREADY_EXISTS na criação: erro no campo do documento', async () => {
    const { dialog } = await openCreate(() =>
      problemResponse(
        409,
        'SUPPLIER_ALREADY_EXISTS',
        'Já existe um fornecedor cadastrado com este documento.',
      ),
    );
    await userEvent.type(within(dialog).getByLabelText('Número do documento *'), '33000167000101');
    await userEvent.type(within(dialog).getByLabelText('Razão social / Nome *'), 'Duplicada Ltda');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(
      await within(dialog).findByText('Já existe um fornecedor cadastrado com este documento.'),
    ).toBeTruthy();
  });

  it('503 na criação: mantém os dados e avisa para tentar novamente', async () => {
    const { dialog } = await openCreate(() =>
      problemResponse(503, 'DEPENDENCY_UNAVAILABLE', 'indisponível'),
    );
    await userEvent.type(within(dialog).getByLabelText('Número do documento *'), '33000167000101');
    await userEvent.type(within(dialog).getByLabelText('Razão social / Nome *'), 'Sem Banco Ltda');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(
      await within(dialog).findByText(
        'Não foi possível salvar agora. Tente novamente em instantes.',
      ),
    ).toBeTruthy();
    expect(within(dialog).getByLabelText<HTMLInputElement>('Razão social / Nome *').value).toBe(
      'Sem Banco Ltda',
    );
  });

  it('erros por campo do servidor (e-mail inválido) aparecem no campo', async () => {
    const { dialog } = await openCreate(() =>
      problemResponse(422, 'VALIDATION_ERROR', 'Revise os campos destacados.', [
        { field: 'website', code: 'INVALID_FORMAT', message: 'Informe um website válido.' },
      ]),
    );
    await userEvent.type(within(dialog).getByLabelText('Número do documento *'), '33000167000101');
    await userEvent.type(within(dialog).getByLabelText('Razão social / Nome *'), 'Sem Site Ltda');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(await within(dialog).findByText('Informe um website válido.')).toBeTruthy();
  });
});

describe('[Concorrência] edição', () => {
  it('412: oferece recarregar e reaplicar as alterações do formulário (SUP-03 + SUP-04)', async () => {
    const fresh = { ...ABC, tradeName: 'ABC Atualizada', version: 2 };
    const api = mockApi({
      patch: (_url, init) => {
        const headers = new Headers(init?.headers);
        return headers.get('If-Match') === '"1"'
          ? problemResponse(412, 'VERSION_CONFLICT', 'Versão desatualizada.')
          : jsonResponse({ data: { ...fresh, phone: '4833', version: 3 } });
      },
      get: () => jsonResponse({ data: fresh }),
    });
    renderWithShell(<SuppliersView />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Editar Construtora ABC Ltda' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Editar Construtora ABC Ltda' });
    await userEvent.type(within(dialog).getByLabelText('Telefone'), '4833');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    expect(
      await within(dialog).findByText('Este fornecedor foi alterado por outra pessoa.'),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Recarregar e reaplicar minhas alterações' }),
    );
    await waitFor(() => {
      expect(within(dialog).getByLabelText<HTMLInputElement>('Nome fantasia').value).toBe(
        'ABC Atualizada',
      );
    });
    expect(within(dialog).getByLabelText<HTMLInputElement>('Telefone').value).toBe('4833');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => {
      expect(callsTo(api, 'PATCH')).toHaveLength(2);
    });
    expect(callOf(api, 'PATCH', 1).headers.get('If-Match')).toBe('"2"');
  });
});
