// @vitest-environment jsdom
import type { DepartmentDto, OrganizationDto } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { DepartmentsView } from './departments-view';
import { StructureView } from '../organizations/structure-view';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => '/admin/estrutura',
}));

const ORG: OrganizationDto = {
  id: '0192a000-0000-7000-8000-0000000100a1',
  name: 'Prefeitura Municipal',
  shortName: 'PMSJ',
  cnpj: '11222333000181',
  type: 'DIRECT_ADMINISTRATION',
  isActive: true,
  isPrimary: true,
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
};

let sequence = 0;
function unit(name: string, parent: DepartmentDto | null, extra: Partial<DepartmentDto> = {}) {
  sequence += 1;
  const id = `0192a000-0000-7000-8000-${String(sequence).padStart(12, '0')}`;
  return {
    id,
    organizationId: ORG.id,
    parentId: parent?.id ?? null,
    type: parent ? 'SECTOR' : 'SECRETARIAT',
    name,
    acronym: null,
    code: null,
    email: null,
    phone: null,
    headUserId: null,
    deputyUserId: null,
    isActive: true,
    isSecretariat: parent === null,
    sortOrder: 0,
    path: `${parent?.path ?? '/'}${id}/`,
    depth: parent ? parent.depth + 1 : 0,
    createdAt: '2026-10-15T12:00:00.000Z',
    updatedAt: '2026-10-15T12:00:00.000Z',
    version: 1,
    ...extra,
  } satisfies DepartmentDto;
}

const OBRAS = unit('Secretaria de Obras', null, { acronym: 'SOB' });
const PROJETOS = unit('Departamento de Projetos', OBRAS, { type: 'DEPARTMENT', version: 2 });
const TOPOGRAFIA = unit('Setor de Topografia', PROJETOS);
const SAUDE = unit('Secretaria de Saúde', null);
const TREE = [OBRAS, PROJETOS, TOPOGRAFIA, SAUDE];

function problemResponse(
  status: number,
  code: string,
  detail: string,
  errors: { field: string; code: string; message: string }[] = [],
  extra: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      type: `https://docs.contrataflow.com.br/errors/${code.toLowerCase()}`,
      title: code,
      status,
      detail,
      instance: '/api/v1/departments',
      code,
      correlationId: 'c-test',
      errors,
      violations: [],
      ...extra,
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function mockApi(
  routes: { list?: Handler; post?: Handler; patch?: Handler; remove?: Handler; get?: Handler } = {},
  permissions: readonly string[] = ['DEPARTMENT_MANAGE'],
  settings: Record<string, unknown> = {},
) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/v1/me/permissions')) {
      return Promise.resolve(
        jsonResponse({ data: { permissions: permissions.map((code) => ({ code, scopes: [] })) } }),
      );
    }
    if (url.startsWith('/api/v1/organizations?')) {
      return Promise.resolve(jsonResponse({ data: [ORG], meta: { page: 1 } }));
    }
    if (url.startsWith('/api/v1/settings/public')) {
      return Promise.resolve(jsonResponse({ data: settings }));
    }
    if (method === 'GET' && url.startsWith('/api/v1/departments?')) {
      return Promise.resolve(
        (
          routes.list ??
          (() => jsonResponse({ data: TREE, meta: { page: 1, totalItems: TREE.length } }))
        )(url, init),
      );
    }
    if (method === 'GET' && url.startsWith('/api/v1/departments/')) {
      return Promise.resolve(
        (routes.get ?? (() => problemResponse(404, 'NOT_FOUND', 'x')))(url, init),
      );
    }
    if (method === 'POST' || method === 'PATCH') {
      const handler = method === 'PATCH' ? routes.patch : routes.post;
      return Promise.resolve(
        (handler ?? (() => problemResponse(500, 'INTERNAL_ERROR', 'x')))(url, init),
      );
    }
    if (method === 'DELETE') {
      return Promise.resolve(
        (routes.remove ?? (() => new Response(null, { status: 204 })))(url, init),
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
  return { url: requestUrl(call[0]), init: call[1], headers: new Headers(call[1]?.headers) };
}

const actionsOf = async (name: string) => {
  await userEvent.click(await screen.findByRole('button', { name: `Ações de ${name}` }));
  return screen.getByRole('group', { name: `Ações de ${name}` });
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[Sucesso] SCR-032 · aba Secretarias', () => {
  it('árvore ARIA expandida, rótulo configurável e sem violações sérias de a11y', async () => {
    mockApi({}, ['DEPARTMENT_MANAGE'], { 'labels.secretariat': 'Diretoria' });
    renderWithShell(<StructureView />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Secretarias' }));

    const tree = await screen.findByRole('tree', { name: 'Estrutura de Prefeitura Municipal' });
    const items = within(tree).getAllByRole('treeitem');
    expect(items.map((item) => item.getAttribute('aria-level'))).toEqual(['1', '2', '3', '1']);
    expect(items[0]?.getAttribute('aria-expanded')).toBe('true');
    expect(items[0]?.textContent).toContain('SOB');
    // FA-06: o tipo SECRETARIAT aparece com o rótulo da instituição.
    await waitFor(() => {
      expect(items[0]?.textContent).toContain('Diretoria');
    });
    expect(await screen.findByRole('button', { name: 'Nova unidade' })).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('teclado: setas percorrem os nós visíveis, esquerda recolhe e volta ao pai', async () => {
    mockApi({}, []);
    renderWithShell(<DepartmentsView />);
    const tree = await screen.findByRole('tree');
    const [obras] = within(tree).getAllByRole('treeitem');
    obras?.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement?.textContent).toContain('Departamento de Projetos');
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement?.textContent).toContain('Setor de Topografia');
    await userEvent.keyboard('{ArrowLeft}');
    expect(document.activeElement?.textContent).toContain('Departamento de Projetos');
    await userEvent.keyboard('{ArrowLeft}');
    expect(within(tree).queryByText('Setor de Topografia')).toBeNull();
    await userEvent.keyboard('{ArrowRight}');
    expect(within(tree).getByText('Setor de Topografia')).toBeTruthy();
    await userEvent.keyboard('{End}');
    expect(document.activeElement?.textContent).toContain('Secretaria de Saúde');
    await userEvent.keyboard('{Home}');
    expect(document.activeElement?.textContent).toContain('Secretaria de Obras');
  });

  it('criar unidade na raiz: corpo do DEP-03 com Idempotency-Key e árvore relida', async () => {
    const created = unit('Secretaria de Cultura', null);
    const api = mockApi({
      post: () => jsonResponse({ data: created }, { status: 201, headers: { ETag: '"1"' } }),
    });
    renderWithShell(<DepartmentsView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Nova unidade' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nova unidade' });
    await userEvent.selectOptions(within(dialog).getByLabelText('Tipo *'), 'SECRETARIAT');
    await userEvent.type(within(dialog).getByLabelText('Nome *'), 'Secretaria de Cultura');
    await userEvent.type(within(dialog).getByLabelText('Sigla'), 'sec');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => {
      expect(callsTo(api, 'POST')).toHaveLength(1);
    });
    const post = callOf(api, 'POST');
    expect(post.url).toBe('/api/v1/departments');
    expect(post.headers.get('Idempotency-Key')).toMatch(/.+/);
    expect(bodyOf(post.init)).toEqual({
      organizationId: ORG.id,
      type: 'SECRETARIAT',
      name: 'Secretaria de Cultura',
      acronym: 'sec',
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(
        api.mock.calls.filter(([url]) => requestUrl(url).startsWith('/api/v1/departments?')).length,
      ).toBeGreaterThan(1);
    });
  });

  it('nova subunidade: parentId da unidade escolhida', async () => {
    const api = mockApi({
      post: () => jsonResponse({ data: unit('Setor Novo', SAUDE) }, { status: 201 }),
    });
    renderWithShell(<DepartmentsView />);
    const group = await actionsOf('Secretaria de Saúde');
    await userEvent.click(within(group).getByRole('button', { name: 'Nova subunidade' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Nova unidade em Secretaria de Saúde',
    });
    await userEvent.selectOptions(within(dialog).getByLabelText('Tipo *'), 'SECTOR');
    await userEvent.type(within(dialog).getByLabelText('Nome *'), 'Setor Novo');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => {
      expect(callsTo(api, 'POST')).toHaveLength(1);
    });
    expect(bodyOf(callOf(api, 'POST').init)).toMatchObject({ parentId: SAUDE.id });
  });

  it('mover por "Mover para…": só destinos válidos e DEP-06 com If-Match', async () => {
    const api = mockApi({
      post: () =>
        jsonResponse({ data: { ...PROJETOS, parentId: SAUDE.id, version: 3 } }, { status: 200 }),
    });
    renderWithShell(<DepartmentsView />);
    const group = await actionsOf('Departamento de Projetos');
    await userEvent.click(within(group).getByRole('button', { name: 'Mover para…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mover Departamento de Projetos' });
    const select = within(dialog).getByLabelText('Nova unidade superior');
    const options = within(select)
      .getAllByRole('option')
      .map((option) => option.textContent);
    // Nem a própria unidade, nem o descendente, nem o pai atual.
    expect(options).toEqual(['Primeiro nível do órgão', 'Secretaria de Saúde']);
    await userEvent.selectOptions(select, SAUDE.id);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mover' }));

    await waitFor(() => {
      expect(callsTo(api, 'POST')).toHaveLength(1);
    });
    const post = callOf(api, 'POST');
    expect(post.url).toBe(`/api/v1/departments/${PROJETOS.id}/move`);
    expect(post.headers.get('If-Match')).toBe('"2"');
    expect(bodyOf(post.init)).toEqual({ parentId: SAUDE.id });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});

describe('[Validação] SCR-032 · aba Secretarias', () => {
  it('campos obrigatórios no front: nenhuma chamada à API', async () => {
    const api = mockApi();
    renderWithShell(<DepartmentsView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Nova unidade' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nova unidade' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(await within(dialog).findByText('Informe o tipo.')).toBeTruthy();
    expect(within(dialog).getByText('Informe o nome.')).toBeTruthy();
    expect(callsTo(api, 'POST')).toHaveLength(0);
  });

  it('erro da API no campo (sigla repetida) fica no formulário', async () => {
    mockApi({
      post: () =>
        problemResponse(422, 'VALIDATION_ERROR', 'Revise os campos destacados.', [
          {
            field: 'acronym',
            code: 'INVALID_FORMAT',
            message: 'Esta sigla já está em uso no órgão.',
          },
        ]),
    });
    renderWithShell(<DepartmentsView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Nova unidade' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nova unidade' });
    await userEvent.selectOptions(within(dialog).getByLabelText('Tipo *'), 'SECTOR');
    await userEvent.type(within(dialog).getByLabelText('Nome *'), 'Setor Repetido');
    await userEvent.type(within(dialog).getByLabelText('Sigla'), 'SOB');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(await within(dialog).findByText('Esta sigla já está em uso no órgão.')).toBeTruthy();
    expect(within(dialog).getByLabelText('Sigla').getAttribute('aria-invalid')).toBe('true');
  });

  it('mover criando ciclo: a mensagem da API aparece no diálogo', async () => {
    mockApi({
      post: () =>
        problemResponse(
          422,
          'DEPARTMENT_CYCLE',
          'Não é possível mover uma unidade para dentro dela mesma ou de uma subunidade.',
        ),
    });
    renderWithShell(<DepartmentsView />);
    const group = await actionsOf('Setor de Topografia');
    await userEvent.click(within(group).getByRole('button', { name: 'Mover para…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mover Setor de Topografia' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mover' }));
    expect(await within(dialog).findByText('Esta movimentação criaria um ciclo.')).toBeTruthy();
  });

  it('excluir unidade em uso (409): orienta e oferece "Desativar"', async () => {
    const api = mockApi({
      remove: () =>
        problemResponse(409, 'DEPARTMENT_HAS_REFERENCES', 'em uso', [], {
          references: ['SUBUNITS'],
        }),
      post: () => jsonResponse({ data: { ...OBRAS, isActive: false, version: 2 } }),
    });
    renderWithShell(<DepartmentsView />);
    const group = await actionsOf('Secretaria de Obras');
    await userEvent.click(within(group).getByRole('button', { name: 'Excluir' }));
    const dialog = await screen.findByRole('dialog', { name: 'Excluir Secretaria de Obras?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Excluir' }));
    expect(
      await within(dialog).findByText('Esta unidade está em uso. Desative-a em vez de excluir.'),
    ).toBeTruthy();
    expect(callOf(api, 'DELETE').headers.get('If-Match')).toBe('"1"');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Desativar' }));
    await waitFor(() => {
      expect(callsTo(api, 'POST')).toHaveLength(1);
    });
    expect(callOf(api, 'POST').url).toBe(`/api/v1/departments/${OBRAS.id}/deactivate`);
  });
});

describe('[Permissão] SCR-032 · aba Secretarias', () => {
  it('sem DEPARTMENT_MANAGE: árvore só para leitura, sem ações nem "Nova unidade"', async () => {
    mockApi({}, []);
    renderWithShell(<DepartmentsView />);
    expect(await screen.findByRole('tree')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Nova unidade' })).toBeNull();
    });
    expect(screen.queryByRole('button', { name: /^Ações de/ })).toBeNull();
    expect(screen.queryByText(/Arraste uma unidade/)).toBeNull();
  });
});

describe('[Concorrência] SCR-032 · aba Secretarias', () => {
  it('editar com versão desatualizada (412): oferece recarregar e reaplicar', async () => {
    const fresh = { ...SAUDE, phone: '4833810000', version: 5 };
    const api = mockApi({
      patch: () => problemResponse(412, 'VERSION_CONFLICT', 'conflito', [], { currentVersion: 5 }),
      get: () => jsonResponse({ data: fresh }),
    });
    renderWithShell(<DepartmentsView />);
    const group = await actionsOf('Secretaria de Saúde');
    await userEvent.click(within(group).getByRole('button', { name: 'Editar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Editar Secretaria de Saúde' });
    await userEvent.type(within(dialog).getByLabelText('Código'), 'UO-10');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(
      await within(dialog).findByText('Esta unidade foi alterada por outra pessoa.'),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Recarregar e reaplicar minhas alterações' }),
    );
    await waitFor(() => {
      expect(within(dialog).getByLabelText<HTMLInputElement>('Telefone').value).toBe('4833810000');
    });
    expect(within(dialog).getByLabelText<HTMLInputElement>('Código').value).toBe('UO-10');
    expect(callOf(api, 'PATCH').headers.get('If-Match')).toBe('"1"');
  });
});

describe('[Estados] SCR-032 · aba Secretarias', () => {
  it('órgão sem unidades: assistente para quem gerencia; estado vazio para quem só lê', async () => {
    mockApi({ list: () => jsonResponse({ data: [], meta: { page: 1, totalItems: 0 } }) });
    const first = renderWithShell(<DepartmentsView />);
    expect(await screen.findByRole('heading', { name: 'Monte a estrutura mínima' })).toBeTruthy();
    first.unmount();

    mockApi({ list: () => jsonResponse({ data: [], meta: { page: 1, totalItems: 0 } }) }, []);
    renderWithShell(<DepartmentsView />);
    expect(await screen.findByText('Nenhuma unidade cadastrada para este órgão')).toBeTruthy();
  });

  it('erro ao carregar: "Tentar novamente" relê a árvore', async () => {
    let attempts = 0;
    mockApi({
      list: () => {
        attempts += 1;
        return attempts === 1
          ? problemResponse(429, 'RATE_LIMITED', 'Muitas tentativas.')
          : jsonResponse({ data: TREE, meta: { page: 1, totalItems: TREE.length } });
      },
    });
    renderWithShell(<DepartmentsView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('tree')).toBeTruthy();
  });
});
