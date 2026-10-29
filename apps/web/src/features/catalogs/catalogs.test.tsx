// @vitest-environment jsdom
import type { CatalogItemDto } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { CatalogsView } from './catalogs-view';

// A suíte completa roda em paralelo com as demais; o padrão de 1 s é curto para a primeira renderização.
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

let sequence = 0;
function item(overrides: Partial<CatalogItemDto>): CatalogItemDto {
  sequence += 1;
  return {
    id: `0192a000-0000-7000-8000-${String(sequence).padStart(12, '0')}`,
    catalogType: 'MODALITY',
    code: `ITEM_${String(sequence)}`,
    label: `Item ${String(sequence)}`,
    description: null,
    isSystem: true,
    isActive: true,
    sortOrder: sequence,
    parentId: null,
    metadata: { legalBasis: 'Lei 14.133/2021', isDirectContracting: false },
    createdAt: '2026-10-15T12:00:00.000Z',
    updatedAt: '2026-10-15T12:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

const PREGAO = item({ code: 'PREGAO', label: 'Pregão', sortOrder: 1, version: 3 });
const CONCORRENCIA = item({ code: 'CONCORRENCIA', label: 'Concorrência', sortOrder: 2 });
const DISPENSA = item({
  code: 'DISPENSA',
  label: 'Dispensa de licitação',
  sortOrder: 3,
  isActive: false,
  metadata: { legalBasis: 'Lei 14.133/2021, art. 75', isDirectContracting: true },
});
const PROPRIO = item({
  code: 'REGISTRO_PRECOS',
  label: 'Registro de preços',
  sortOrder: 4,
  isSystem: false,
});
const MODALITIES = [PREGAO, CONCORRENCIA, DISPENSA, PROPRIO];

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
      instance: '/api/v1/catalogs',
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
  routes: {
    list?: Handler;
    post?: Handler;
    patch?: Handler;
    toggle?: Handler;
    order?: Handler;
    tags?: Handler;
  } = {},
  permissions: readonly string[] = ['CATALOG_MANAGE'],
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
    if (method === 'GET' && url.startsWith('/api/v1/tags')) {
      return Promise.resolve((routes.tags ?? (() => jsonResponse({ data: [] })))(url, init));
    }
    const type = /\/catalogs\/([A-Z_]+)\//.exec(url)?.[1];
    if (method === 'GET' && url.startsWith('/api/v1/catalogs/')) {
      const handler =
        routes.list ??
        (() =>
          jsonResponse({
            data: type === 'MODALITY' ? MODALITIES : [],
            meta: { page: 1, pageSize: 100, totalItems: 4, totalPages: 1 },
          }));
      return Promise.resolve(handler(url, init));
    }
    if (method === 'POST' && /\/catalogs\/[A-Z_]+\/items$/.test(url)) {
      return Promise.resolve(
        (routes.post ?? (() => problemResponse(500, 'INTERNAL_ERROR', 'x')))(url, init),
      );
    }
    if (method === 'POST' && /\/catalog-items\/.+\/(activate|deactivate)$/.test(url)) {
      return Promise.resolve(
        (routes.toggle ?? (() => problemResponse(500, 'INTERNAL_ERROR', 'x')))(url, init),
      );
    }
    if (method === 'PATCH') {
      return Promise.resolve(
        (routes.patch ?? (() => problemResponse(500, 'INTERNAL_ERROR', 'x')))(url, init),
      );
    }
    if (method === 'PUT') {
      return Promise.resolve(
        (routes.order ?? (() => problemResponse(500, 'INTERNAL_ERROR', 'x')))(url, init),
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

/** Menu ⋯ da linha: abre "Ações de X" e escolhe o item. */
async function chooseRowAction(name: string, action: string): Promise<void> {
  await userEvent.click(await screen.findByRole('button', { name: `Ações de ${name}` }));
  await userEvent.click(await screen.findByRole('menuitem', { name: action }));
}

describe('[Sucesso] SCR-109 · lista', () => {
  it('abas dos 8 catálogos, itens por ordem com selo "Padrão do sistema" e situação; sem violações de a11y', async () => {
    const api = mockApi();
    renderWithShell(<CatalogsView />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Catálogos' })).toBeTruthy();
    expect(screen.getAllByRole('tab')).toHaveLength(8);
    expect(
      screen.getByRole('tab', { name: 'Tipos de contratação' }).getAttribute('aria-selected'),
    ).toBe('true');
    await userEvent.click(screen.getByRole('tab', { name: 'Modalidades' }));

    const table = await screen.findByRole('table', { name: 'Itens do catálogo Modalidades' });
    expect(
      api.mock.calls.some(([url]) =>
        requestUrl(url).startsWith('/api/v1/catalogs/MODALITY/items?'),
      ),
    ).toBe(true);
    const rows = within(table).getAllByRole('row');
    expect(rows.map((row) => within(row).queryByText(/^[A-Z_]+$/)?.textContent).slice(1)).toEqual([
      'PREGAO',
      'CONCORRENCIA',
      'DISPENSA',
      'REGISTRO_PRECOS',
    ]);
    const pregao = within(table).getByRole('row', { name: /Pregão/ });
    expect(within(pregao).getByText('Padrão do sistema')).toBeTruthy();
    expect(within(pregao).getByText('Ativo')).toBeTruthy();
    const dispensa = within(table).getByRole('row', { name: /Dispensa de licitação/ });
    expect(within(dispensa).getByText('Inativo')).toBeTruthy();
    const proprio = within(table).getByRole('row', { name: /Registro de preços/ });
    expect(within(proprio).queryByText('Padrão do sistema')).toBeNull();
    // Itens de sistema mostram o cadeado com a explicação; o item próprio não.
    expect(within(pregao).getByRole('button', { name: 'Por que Pregão é imutável' })).toBeTruthy();
    expect(within(proprio).queryByRole('button', { name: /Por que/ })).toBeNull();
    // Nenhum item oferece "Excluir" (RN-TEN-64).
    expect(screen.queryByRole('button', { name: /excluir/i })).toBeNull();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('navegação por teclado entre as abas (setas, Home e End)', async () => {
    mockApi();
    renderWithShell(<CatalogsView />);
    const first = await screen.findByRole('tab', { name: 'Tipos de contratação' });
    first.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Modalidades' }));
    expect(screen.getByRole('tab', { name: 'Modalidades' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    await userEvent.keyboard('{End}');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Categorias de anexo' }));
    await userEvent.keyboard('{Home}');
    expect(document.activeElement).toBe(first);
  });

  it('carregando, vazio e erro com "Tentar novamente"', async () => {
    mockApi({ list: () => new Promise<Response>(() => undefined) });
    const first = renderWithShell(<CatalogsView />);
    expect((await screen.findByText('Carregando os itens…')).textContent).toBeTruthy();
    first.unmount();

    mockApi({ list: () => jsonResponse({ data: [], meta: { page: 1 } }) });
    const second = renderWithShell(<CatalogsView />);
    expect(await screen.findByText('Nenhum item neste catálogo')).toBeTruthy();
    second.unmount();

    let calls = 0;
    mockApi({
      list: () => {
        calls += 1;
        return calls === 1
          ? problemResponse(429, 'RATE_LIMITED', 'Muitas tentativas.')
          : jsonResponse({ data: MODALITIES, meta: { page: 1 } });
      },
    });
    renderWithShell(<CatalogsView />);
    expect(await screen.findByText('Não foi possível carregar os itens do catálogo.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('table')).toBeTruthy();
  });

  it('FA-04: catálogo sem nenhum item ativo orienta a ativar ou criar', async () => {
    mockApi({
      list: () => jsonResponse({ data: [{ ...DISPENSA }], meta: { page: 1 } }),
    });
    renderWithShell(<CatalogsView />);
    expect(await screen.findByText('Nenhum item ativo neste catálogo')).toBeTruthy();
    expect(screen.getByRole('table')).toBeTruthy();
  });
});

describe('[Permissão] ações de edição', () => {
  it('403 na leitura: mensagem de permissão no lugar da lista', async () => {
    mockApi({ list: () => problemResponse(403, 'PERMISSION_DENIED', 'Você não tem permissão.') });
    renderWithShell(<CatalogsView />);
    expect(
      await screen.findByText('Você não tem permissão para gerenciar catálogos.'),
    ).toBeTruthy();
  });

  it('sem CATALOG_MANAGE a lista fica visível e as ações de edição, ocultas', async () => {
    mockApi({}, []);
    renderWithShell(<CatalogsView />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Modalidades' }));
    expect(await screen.findByRole('table')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Novo item' })).toBeNull();
    });
    expect(screen.queryByRole('button', { name: /Ações de/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Mover/ })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Ações' })).toBeNull();
  });
});

describe('[Sucesso] criar e editar', () => {
  it('criar item com metadata do tipo: corpo de CAT-02 e lista relida', async () => {
    const created = item({ code: 'ARP', label: 'Ata de registro de preços', isSystem: false });
    const api = mockApi({
      post: () => jsonResponse({ data: created }, { status: 201, headers: { ETag: '"1"' } }),
    });
    renderWithShell(<CatalogsView />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Modalidades' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Novo item' }));
    const dialog = await screen.findByRole('dialog', { name: 'Novo item — Modalidades' });

    await userEvent.type(within(dialog).getByLabelText('Código *'), 'ARP');
    await userEvent.type(within(dialog).getByLabelText('Rótulo *'), 'Ata de registro de preços');
    await userEvent.type(within(dialog).getByLabelText('Base legal *'), 'Lei 14.133/2021, art. 82');
    await userEvent.click(within(dialog).getByLabelText('Contratação direta *'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => {
      expect(callsTo(api, 'POST')).toHaveLength(1);
    });
    const post = callOf(api, 'POST');
    expect(post.url).toBe('/api/v1/catalogs/MODALITY/items');
    expect(bodyOf(post.init)).toEqual({
      code: 'ARP',
      label: 'Ata de registro de preços',
      metadata: { legalBasis: 'Lei 14.133/2021, art. 82', isDirectContracting: true },
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(
        api.mock.calls.filter(([url]) =>
          requestUrl(url).startsWith('/api/v1/catalogs/MODALITY/items?'),
        ).length,
      ).toBeGreaterThan(1);
    });
  });

  it('editar: código bloqueado, envia só o que mudou com If-Match da versão lida', async () => {
    const api = mockApi({
      patch: () =>
        jsonResponse(
          { data: { ...PREGAO, label: 'Pregão eletrônico', version: 4 } },
          { status: 200 },
        ),
    });
    renderWithShell(<CatalogsView />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Modalidades' }));
    await chooseRowAction('Pregão', 'Editar');
    const dialog = await screen.findByRole('dialog', { name: 'Editar Pregão' });

    const code = within(dialog).getByLabelText<HTMLInputElement>('Código *');
    expect(code.readOnly).toBe(true);
    expect(code.value).toBe('PREGAO');
    expect(within(dialog).getByText('Item padrão do sistema: o código é fixo.')).toBeTruthy();

    const label = within(dialog).getByLabelText('Rótulo *');
    await userEvent.clear(label);
    await userEvent.type(label, 'Pregão eletrônico');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => {
      expect(callsTo(api, 'PATCH')).toHaveLength(1);
    });
    const patch = callOf(api, 'PATCH');
    expect(patch.url).toBe(`/api/v1/catalog-items/${PREGAO.id}`);
    expect(patch.headers.get('If-Match')).toBe('"3"');
    expect(bodyOf(patch.init)).toEqual({ label: 'Pregão eletrônico' });
  });

  it('desativar (FA-02): aviso sem efeito retroativo, depois ativar direto; ambos com If-Match', async () => {
    const api = mockApi({
      toggle: () => jsonResponse({ data: { ...CONCORRENCIA, isActive: false, version: 2 } }),
    });
    renderWithShell(<CatalogsView />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Modalidades' }));
    await chooseRowAction('Concorrência', 'Desativar');
    const dialog = await screen.findByRole('dialog', { name: 'Desativar Concorrência?' });
    expect(
      within(dialog).getByText(
        'Este item deixará de aparecer em novas seleções; registros existentes não são afetados.',
      ),
    ).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Desativar' }));
    await waitFor(() => {
      expect(callsTo(api, 'POST')).toHaveLength(1);
    });
    expect(callOf(api, 'POST').url).toBe(`/api/v1/catalog-items/${CONCORRENCIA.id}/deactivate`);
    expect(callOf(api, 'POST').headers.get('If-Match')).toBe('"1"');

    await chooseRowAction('Dispensa de licitação', 'Ativar');
    await waitFor(() => {
      expect(callsTo(api, 'POST')).toHaveLength(2);
    });
    expect(callOf(api, 'POST', 1).url).toBe(`/api/v1/catalog-items/${DISPENSA.id}/activate`);
  });
});

describe('[Sucesso] campo de seleção da metadata', () => {
  it('Origens do processo: escolhe a situação exigida no PCA pelo Select do kit', async () => {
    const created = item({ code: 'EMENDA', label: 'Emenda', isSystem: false });
    const api = mockApi({
      post: () => jsonResponse({ data: created }, { status: 201, headers: { ETag: '"1"' } }),
    });
    renderWithShell(<CatalogsView />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Origens do processo' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Novo item' }));
    const dialog = await screen.findByRole('dialog', { name: 'Novo item — Origens do processo' });
    await userEvent.type(within(dialog).getByLabelText('Código *'), 'EMENDA');
    await userEvent.type(within(dialog).getByLabelText('Rótulo *'), 'Emenda');
    await userEvent.click(
      within(dialog).getByRole('combobox', { name: 'Situação exigida no PCA' }),
    );
    await userEvent.click(await screen.findByRole('option', { name: 'Previsto no PCA' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => {
      expect(callsTo(api, 'POST')).toHaveLength(1);
    });
    expect(bodyOf(callOf(api, 'POST').init)).toEqual({
      code: 'EMENDA',
      label: 'Emenda',
      metadata: { requiresPcaStatus: 'PLANNED' },
    });
  });
});

describe('[Sucesso] reordenar', () => {
  it('"Mover para baixo" envia a lista completa de IDs na nova ordem (CAT-06) e reflete o resultado', async () => {
    const reordered = [CONCORRENCIA, PREGAO, DISPENSA, PROPRIO].map((entry, index) => ({
      ...entry,
      sortOrder: index + 1,
    }));
    const api = mockApi({ order: () => jsonResponse({ data: reordered }) });
    renderWithShell(<CatalogsView />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Modalidades' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Mover Pregão para baixo' }));

    await waitFor(() => {
      expect(callsTo(api, 'PUT')).toHaveLength(1);
    });
    const put = callOf(api, 'PUT');
    expect(put.url).toBe('/api/v1/catalogs/MODALITY/order');
    expect(bodyOf(put.init)).toEqual({
      orderedIds: [CONCORRENCIA.id, PREGAO.id, DISPENSA.id, PROPRIO.id],
    });
    await waitFor(() => {
      const labels = within(screen.getByRole('table'))
        .getAllByRole('rowheader')
        .map((cell) => cell.firstElementChild?.textContent);
      expect(labels).toEqual([
        'Concorrência',
        'Pregão',
        'Dispensa de licitação',
        'Registro de preços',
      ]);
    });
  });

  it('primeiro item não sobe e último não desce', async () => {
    mockApi();
    renderWithShell(<CatalogsView />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Modalidades' }));
    const up = await screen.findByRole<HTMLButtonElement>('button', {
      name: 'Mover Pregão para cima',
    });
    expect(up.disabled).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Mover Registro de preços para baixo' })
        .disabled,
    ).toBe(true);
  });

  it('erro ao reordenar desfaz a ordem e oferece recarregar', async () => {
    mockApi({ order: () => problemResponse(503, 'DEPENDENCY_UNAVAILABLE', 'fora do ar') });
    renderWithShell(<CatalogsView />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Modalidades' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Mover Pregão para baixo' }));
    expect(
      await screen.findByText('Não foi possível salvar agora. Tente novamente em instantes.'),
    ).toBeTruthy();
  });
});

describe('[Validação] e erros do servidor', () => {
  async function openCreate(post?: Handler) {
    const api = mockApi(post ? { post } : {});
    renderWithShell(<CatalogsView />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Categorias de anexo' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Novo item' }));
    const dialog = await screen.findByRole('dialog', { name: 'Novo item — Categorias de anexo' });
    return { api, dialog };
  }

  it('obrigatórios em branco e código fora do padrão: erro inline e nada é enviado', async () => {
    const { api, dialog } = await openCreate();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(await within(dialog).findByText('Informe o código.')).toBeTruthy();
    expect(within(dialog).getByText('Informe o rótulo.')).toBeTruthy();

    await userEvent.type(within(dialog).getByLabelText('Código *'), 'servico novo');
    await userEvent.type(within(dialog).getByLabelText('Rótulo *'), 'Serviço novo');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(
      await within(dialog).findByText(
        'Use letras maiúsculas, números e sublinhado, sem repetir um código existente.',
      ),
    ).toBeTruthy();
    expect(callsTo(api, 'POST')).toHaveLength(0);
  });

  it('código duplicado vindo da API: erro no campo código', async () => {
    const { dialog } = await openCreate(() =>
      problemResponse(422, 'VALIDATION_ERROR', 'Revise os campos destacados.', [
        {
          field: 'code',
          code: 'INVALID_FORMAT',
          message: 'Já existe um item com este código neste catálogo.',
        },
      ]),
    );
    await userEvent.type(within(dialog).getByLabelText('Código *'), 'OUTRO');
    await userEvent.type(within(dialog).getByLabelText('Rótulo *'), 'Outro');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(
      await within(dialog).findByText('Já existe um item com este código neste catálogo.'),
    ).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('412 ao editar: avisa que outra pessoa alterou, fecha o diálogo e recarrega a lista', async () => {
    const api = mockApi({
      patch: () => problemResponse(412, 'VERSION_CONFLICT', 'conflito', [], { currentVersion: 5 }),
    });
    renderWithShell(<CatalogsView />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Modalidades' }));
    await chooseRowAction('Pregão', 'Editar');
    const dialog = await screen.findByRole('dialog', { name: 'Editar Pregão' });
    const label = within(dialog).getByLabelText('Rótulo *');
    await userEvent.clear(label);
    await userEvent.type(label, 'Outro nome');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    expect(
      await screen.findByText('Este item foi alterado por outra pessoa. Recarregue a lista.'),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await userEvent.click(screen.getByRole('button', { name: 'Recarregar a lista' }));
    await waitFor(() => {
      expect(
        api.mock.calls.filter(([url]) =>
          requestUrl(url).startsWith('/api/v1/catalogs/MODALITY/items?'),
        ).length,
      ).toBeGreaterThan(1);
    });
  });

  it('metadata do tipo é obrigatória no formulário de Modalidades', async () => {
    const api = mockApi();
    renderWithShell(<CatalogsView />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Modalidades' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Novo item' }));
    const dialog = await screen.findByRole('dialog', { name: 'Novo item — Modalidades' });
    await userEvent.type(within(dialog).getByLabelText('Código *'), 'NOVA');
    await userEvent.type(within(dialog).getByLabelText('Rótulo *'), 'Nova');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(await within(dialog).findByText('Revise este campo.')).toBeTruthy();
    expect(callsTo(api, 'POST')).toHaveLength(0);
  });
});

describe('[Permissão] SCR-109 · aba "Etiquetas" (US-007)', () => {
  const TAG = {
    id: '0192a000-0000-7000-8000-000000000999',
    name: 'Obras emergenciais',
    color: '#B45309',
    isActive: true,
    version: 1,
  };

  it('com TAG_MANAGE a aba existe (por teclado também) e abre o cadastro de etiquetas', async () => {
    mockApi({ tags: () => jsonResponse({ data: [TAG] }) }, ['CATALOG_MANAGE', 'TAG_MANAGE']);
    renderWithShell(<CatalogsView />);
    const tab = await screen.findByRole('tab', { name: 'Etiquetas' });
    expect(screen.getAllByRole('tab')).toHaveLength(9);
    expect(tab.getAttribute('aria-selected')).toBe('false');

    // End vai para a última aba, a de etiquetas.
    screen.getByRole('tab', { name: 'Tipos de contratação' }).focus();
    await userEvent.keyboard('{End}');
    expect(tab.getAttribute('aria-selected')).toBe('true');
    const panel = screen.getByRole('tabpanel');
    expect(await within(panel).findByRole('table', { name: 'Etiquetas do órgão' })).toBeTruthy();
    expect(within(panel).getByText('Obras emergenciais')).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Nova etiqueta' })).toBeTruthy();

    await userEvent.click(screen.getByRole('tab', { name: 'Modalidades' }));
    expect(
      await screen.findByRole('table', { name: 'Itens do catálogo Modalidades' }),
    ).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Etiquetas do órgão' })).toBeNull();
  });

  it('sem TAG_MANAGE a aba "Etiquetas" fica oculta', async () => {
    mockApi({}, ['CATALOG_MANAGE']);
    renderWithShell(<CatalogsView />);
    await screen.findByRole('tab', { name: 'Modalidades' });
    expect(screen.queryByRole('tab', { name: 'Etiquetas' })).toBeNull();
  });
});
