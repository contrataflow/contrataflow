// @vitest-environment jsdom
import { DEFAULT_TEMPLATE_LAYOUT, DEFAULT_TR_IMPORT_MAPPINGS } from '@contrataflow/validation';
import type { DocumentTypeDto, TemplateDto, TemplateVersionDto } from '@contrataflow/validation';
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { TemplateEditorView } from './template-editor';
import { TemplatesView } from './templates-view';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
  usePathname: () => '/admin/templates',
}));

const NOW = '2026-10-15T12:00:00.000Z';
const DESPACHO_TYPE = {
  id: '0192a000-0000-7000-8000-0000000d0001',
  code: 'DESPACHO',
  name: 'Despacho',
  kind: 'FREE_TEXT',
  systemModule: null,
  defaultConfidentiality: 'INTERNAL',
} as const;
const TR_TYPE = {
  id: '0192a000-0000-7000-8000-0000000d0002',
  code: 'TR',
  name: 'Termo de Referência',
  kind: 'STRUCTURED',
  systemModule: 'TERM_OF_REFERENCE',
  defaultConfidentiality: 'INTERNAL',
} as const;

const TEMPLATE_ID = '0192a000-0000-7000-8000-0000000e0001';
const VERSION_ID = '0192a000-0000-7000-8000-0000000f0001';

function template(overrides: Partial<TemplateDto> = {}): TemplateDto {
  return {
    id: TEMPLATE_ID,
    name: 'Despacho padrão',
    description: null,
    documentTypeId: DESPACHO_TYPE.id,
    documentType: DESPACHO_TYPE,
    isActive: true,
    isSystem: false,
    draftVersion: {
      id: VERSION_ID,
      versionNumber: 1,
      status: 'DRAFT',
      sectionCount: 0,
      updatedAt: NOW,
      publishedAt: null,
    },
    currentPublishedVersion: null,
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    ...overrides,
  };
}

function version(overrides: Partial<TemplateVersionDto> = {}): TemplateVersionDto {
  return {
    id: VERSION_ID,
    templateId: TEMPLATE_ID,
    templateName: 'Despacho padrão',
    versionNumber: 1,
    status: 'DRAFT',
    documentType: DESPACHO_TYPE,
    sections: [],
    fieldConfig: {},
    importMappings: null,
    layout: DEFAULT_TEMPLATE_LAYOUT,
    changeNotes: null,
    importSources: null,
    publishedAt: null,
    retiredAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    version: 3,
    ...overrides,
  };
}

const documentTypes = [
  { ...DESPACHO_TYPE, isActive: true },
  { ...TR_TYPE, isActive: true },
] as unknown as DocumentTypeDto[];

function problemResponse(
  status: number,
  code: string,
  detail: string,
  extra: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      type: `https://docs.contrataflow.com.br/errors/${code.toLowerCase()}`,
      title: code,
      status,
      detail,
      instance: '/api/v1/templates',
      code,
      correlationId: 'c-test',
      errors: [],
      violations: [],
      ...extra,
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function mockApi(
  routes: { list?: Handler; post?: Handler; patch?: Handler; getVersion?: Handler } = {},
  permissions: readonly string[] = ['TEMPLATE_VIEW', 'TEMPLATE_MANAGE'],
) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/v1/me/permissions')) {
      return Promise.resolve(
        jsonResponse({ data: { permissions: permissions.map((code) => ({ code, scopes: [] })) } }),
      );
    }
    if (url.startsWith('/api/v1/document-types')) {
      return Promise.resolve(jsonResponse({ data: documentTypes }));
    }
    if (method === 'GET' && url.startsWith('/api/v1/templates')) {
      return Promise.resolve(
        (
          routes.list ??
          (() => jsonResponse({ data: [template()], meta: { page: 1, totalItems: 1 } }))
        )(url, init),
      );
    }
    if (method === 'GET' && url.startsWith('/api/v1/template-versions/')) {
      return Promise.resolve(
        (routes.getVersion ?? (() => jsonResponse({ data: version() })))(url, init),
      );
    }
    if (method === 'POST') {
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

afterEach(() => {
  vi.unstubAllGlobals();
  push.mockReset();
});

describe('SCR-033 · lista de templates', () => {
  it('[Sucesso] lista com tipo, situação e versões, e ações de edição para TEMPLATE_MANAGE (axe)', async () => {
    mockApi();
    renderWithShell(<TemplatesView />);
    const row = (await screen.findByRole('rowheader', { name: /Despacho padrão/ })).closest('tr');
    if (!row) throw new Error('linha ausente');
    expect(within(row).getByText('Despacho')).toBeTruthy();
    expect(within(row).getByText('Ativo')).toBeTruthy();
    expect(within(row).getByText('Rascunho v1 (sem seções)')).toBeTruthy();
    expect(
      within(row)
        .getByRole('link', { name: 'Editar conteúdo de Despacho padrão' })
        .getAttribute('href'),
    ).toBe(`/admin/templates/${TEMPLATE_ID}/versoes/${VERSION_ID}`);
    expect(await screen.findByRole('button', { name: 'Novo template' })).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('[Permissão] só TEMPLATE_VIEW: sem "Novo template" nem "Editar dados"; link de leitura', async () => {
    mockApi({}, ['TEMPLATE_VIEW']);
    renderWithShell(<TemplatesView />);
    expect(
      await screen.findByRole('link', { name: 'Ver conteúdo de Despacho padrão' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Novo template' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Editar dados de Despacho padrão' })).toBeNull();
  });

  it('403 na lista mostra "Acesso negado"', async () => {
    mockApi({ list: () => problemResponse(403, 'PERMISSION_DENIED', 'Negado') }, []);
    renderWithShell(<TemplatesView />);
    expect(await screen.findByText('Acesso negado')).toBeTruthy();
  });

  it('filtra por nome e por tipo', async () => {
    mockApi({
      list: () =>
        jsonResponse({
          data: [
            template(),
            template({
              id: '0192a000-0000-7000-8000-0000000e0002',
              name: 'TR de serviços',
              documentTypeId: TR_TYPE.id,
              documentType: TR_TYPE,
            }),
          ],
          meta: { page: 1, totalItems: 2 },
        }),
    });
    renderWithShell(<TemplatesView />);
    await screen.findByRole('rowheader', { name: /TR de serviços/ });
    await userEvent.type(screen.getByLabelText('Buscar por nome'), 'servicos');
    expect(screen.queryByRole('rowheader', { name: /Despacho padrão/ })).toBeNull();
    await userEvent.clear(screen.getByLabelText('Buscar por nome'));
    await userEvent.selectOptions(screen.getByLabelText('Tipo de documento'), DESPACHO_TYPE.id);
    expect(screen.queryByRole('rowheader', { name: /TR de serviços/ })).toBeNull();
    expect(screen.getByRole('rowheader', { name: /Despacho padrão/ })).toBeTruthy();
  });

  it('[Sucesso] criar template: POST com Idempotency-Key e vai para o editor da versão 1', async () => {
    const created = template({ id: '0192a000-0000-7000-8000-0000000e0003', name: 'Ofício geral' });
    const api = mockApi({ post: () => jsonResponse({ data: created }, { status: 201 }) });
    renderWithShell(<TemplatesView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Novo template' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Nome'), 'Ofício geral');
    await within(dialog).findByRole('option', { name: 'Despacho' });
    await userEvent.selectOptions(
      within(dialog).getByLabelText('Tipo de documento'),
      DESPACHO_TYPE.id,
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Criar e editar seções' }));

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(`/admin/templates/${created.id}/versoes/${VERSION_ID}`);
    });
    const [post] = callsTo(api, 'POST');
    expect(new Headers(post?.[1]?.headers).get('Idempotency-Key')).toBeTruthy();
    expect(bodyOf(post?.[1])).toEqual({ name: 'Ofício geral', documentTypeId: DESPACHO_TYPE.id });
  });

  it('[Validação/Duplicidade] campos obrigatórios, nome já carregado no tipo e 409 da API', async () => {
    const api = mockApi({
      post: () =>
        problemResponse(
          409,
          'TEMPLATE_NAME_TAKEN',
          'Já existe um template chamado "Outro" para este tipo de documento.',
        ),
    });
    renderWithShell(<TemplatesView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Novo template' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Criar e editar seções' }));
    expect(within(dialog).getByText('Informe o nome.')).toBeTruthy();
    expect(within(dialog).getByText('Informe o tipo de documento.')).toBeTruthy();

    await within(dialog).findByRole('option', { name: 'Despacho' });
    await userEvent.type(within(dialog).getByLabelText('Nome'), 'DESPACHO PADRÃO');
    await userEvent.selectOptions(
      within(dialog).getByLabelText('Tipo de documento'),
      DESPACHO_TYPE.id,
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Criar e editar seções' }));
    expect(
      within(dialog).getByText(
        'Já existe um template chamado "DESPACHO PADRÃO" para este tipo de documento.',
      ),
    ).toBeTruthy();
    expect(callsTo(api, 'POST')).toHaveLength(0);

    await userEvent.clear(within(dialog).getByLabelText('Nome'));
    await userEvent.type(within(dialog).getByLabelText('Nome'), 'Outro');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Criar e editar seções' }));
    expect(
      await within(dialog).findByText(
        'Já existe um template chamado "Outro" para este tipo de documento.',
      ),
    ).toBeTruthy();
  });

  it('FA-03: editar dados envia só o que mudou com If-Match', async () => {
    const api = mockApi({
      patch: () => jsonResponse({ data: template({ isActive: false, version: 2 }) }),
    });
    renderWithShell(<TemplatesView />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Editar dados de Despacho padrão' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getAllByText(/O tipo de documento não muda/).length).toBeGreaterThan(0);
    await userEvent.click(
      within(dialog).getByLabelText('Ativo (disponível para novos documentos)'),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => {
      expect(callsTo(api, 'PATCH')).toHaveLength(1);
    });
    const [patch] = callsTo(api, 'PATCH');
    expect(requestUrl(patch?.[0] ?? '')).toBe(`/api/v1/templates/${TEMPLATE_ID}`);
    expect(new Headers(patch?.[1]?.headers).get('If-Match')).toBe('"1"');
    expect(bodyOf(patch?.[1])).toEqual({ isActive: false });
  });
});

describe('SCR-114 · editor de template (aba Conteúdo)', () => {
  it('[Sucesso] estado vazio, adicionar seção e salvar com If-Match e axe sem violações', async () => {
    const api = mockApi({
      patch: (_url, init) => {
        const body = bodyOf(init);
        return jsonResponse({
          data: version({ sections: body.sections as TemplateVersionDto['sections'], version: 4 }),
        });
      },
    });
    renderWithShell(<TemplateEditorView versionId={VERSION_ID} />);
    expect(await screen.findByText('Nenhuma seção. Adicione a primeira.')).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);

    await userEvent.click(screen.getByRole('button', { name: 'Adicionar seção' }));
    await userEvent.type(screen.getByLabelText('Chave'), 'objeto');
    expect(screen.getByLabelText<HTMLInputElement>('Chave').value).toBe('OBJETO');
    await userEvent.type(screen.getByLabelText('Título'), 'Objeto');
    await userEvent.type(screen.getByLabelText('Texto de ajuda ao redator'), 'Descreva o objeto.');
    await userEvent.click(
      screen.getByRole('button', { name: 'Inserir a variável process.object no conteúdo padrão' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }));

    await waitFor(() => {
      expect(callsTo(api, 'PATCH').length).toBeGreaterThan(0);
    });
    const patch = callsTo(api, 'PATCH').at(-1);
    expect(requestUrl(patch?.[0] ?? '')).toBe(`/api/v1/template-versions/${VERSION_ID}`);
    expect(new Headers(patch?.[1]?.headers).get('If-Match')).toBe('"3"');
    const body = bodyOf(patch?.[1]) as { sections: Record<string, unknown>[] };
    expect(Object.keys(body)).toEqual(['sections']);
    expect(body.sections[0]).toMatchObject({
      key: 'OBJETO',
      title: 'Objeto',
      order: 1,
      requirement: 'REQUIRED',
      helpText: 'Descreva o objeto.',
      render: 'TEXT',
      defaultContent: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '{{process.object}}' }] }],
      },
    });
    expect(
      await screen.findByText('Todas as alterações salvas.', { selector: '[role="status"]' }),
    ).toBeTruthy();
  });

  it('autosave ao sair do campo e reordenação por teclado numa única chamada (FA-01)', async () => {
    const api = mockApi({
      getVersion: () =>
        jsonResponse({
          data: version({
            sections: [
              {
                key: 'A',
                title: 'Primeira',
                order: 1,
                requirement: 'REQUIRED',
                maxChars: 50_000,
                render: 'TEXT',
                allowNarrative: true,
              },
              {
                key: 'B',
                title: 'Segunda',
                order: 2,
                requirement: 'OPTIONAL',
                maxChars: 50_000,
                render: 'TEXT',
                allowNarrative: true,
              },
            ],
          }),
        }),
      patch: (_url, init) => {
        const sent = bodyOf(init).sections as TemplateVersionDto['sections'];
        return jsonResponse({
          data: version({ sections: sent, version: 4 + callsTo(api, 'PATCH').length }),
        });
      },
    });
    renderWithShell(<TemplateEditorView versionId={VERSION_ID} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Mover Segunda para cima' }));
    await waitFor(() => {
      expect(callsTo(api, 'PATCH')).toHaveLength(1);
    });
    const moved = bodyOf(callsTo(api, 'PATCH')[0]?.[1]) as {
      sections: { key: string; order: number }[];
    };
    expect(moved.sections.map((item) => [item.key, item.order])).toEqual([
      ['B', 1],
      ['A', 2],
    ]);

    // Autosave: editar o título e sair do campo.
    await userEvent.click(screen.getByRole('button', { name: 'Editar a seção Primeira' }));
    const title = screen.getByLabelText('Título');
    await userEvent.clear(title);
    await userEvent.type(title, 'Primeira revisada');
    fireEvent.focusOut(title, { relatedTarget: document.body });
    await waitFor(() => {
      expect(callsTo(api, 'PATCH')).toHaveLength(2);
    });
    expect(new Headers(callsTo(api, 'PATCH')[1]?.[1]?.headers).get('If-Match')).toBe('"5"');
  });

  it('[Validação] 422 TEMPLATE_INVALID aparece na seção indicada; validação local bloqueia variável desconhecida', async () => {
    mockApi({
      getVersion: () =>
        jsonResponse({
          data: version({
            sections: [
              {
                key: 'OBJETO',
                title: 'Objeto',
                order: 1,
                requirement: 'REQUIRED',
                maxChars: 50_000,
                render: 'TEXT',
                allowNarrative: true,
              },
            ],
          }),
        }),
      patch: () =>
        problemResponse(422, 'TEMPLATE_INVALID', 'A variável {{tenant.nome}} não é reconhecida.', {
          violations: [
            {
              code: 'TEMPLATE_VARIABLE_UNKNOWN',
              severity: 'BLOCKING',
              message: 'A variável {{tenant.nome}} não é reconhecida.',
              ruleId: null,
              sectionKey: 'OBJETO',
              field: 'helpText',
              itemId: null,
              params: { variable: 'tenant.nome' },
            },
          ],
        }),
    });
    renderWithShell(<TemplateEditorView versionId={VERSION_ID} />);
    const content = await screen.findByLabelText('Conteúdo padrão');
    await userEvent.type(content, 'Assina {{{{document.assinante}}');
    expect(screen.getByText('A variável {{document.assinante}} não é reconhecida.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Salvar alterações' }).hasAttribute('disabled')).toBe(
      true,
    );

    await userEvent.clear(content);
    await userEvent.type(screen.getByLabelText('Base legal'), 'Lei 14.133');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }));
    expect(await screen.findByText('A variável {{tenant.nome}} não é reconhecida.')).toBeTruthy();
    expect(screen.getByText(/com problemas/)).toBeTruthy();
  });

  it('[Concorrência] 412 oferece recarregar', async () => {
    mockApi({
      patch: () =>
        problemResponse(412, 'VERSION_CONFLICT', 'Este template foi alterado por outra pessoa.', {
          currentVersion: 4,
        }),
    });
    renderWithShell(<TemplateEditorView versionId={VERSION_ID} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Adicionar seção' }));
    await userEvent.type(screen.getByLabelText('Chave'), 'A');
    await userEvent.type(screen.getByLabelText('Título'), 'A');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }));
    expect(
      await screen.findByText(
        'Este template foi alterado por outra pessoa. Recarregue para continuar.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Recarregar' })).toBeTruthy();
  });

  it('[Falha] 503 mantém os dados e oferece "Tentar novamente"', async () => {
    mockApi({ patch: () => problemResponse(503, 'DEPENDENCY_UNAVAILABLE', 'Indisponível') });
    renderWithShell(<TemplateEditorView versionId={VERSION_ID} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Adicionar seção' }));
    await userEvent.type(screen.getByLabelText('Chave'), 'A');
    await userEvent.type(screen.getByLabelText('Título'), 'Título mantido');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }));
    expect(await screen.findByRole('button', { name: 'Tentar novamente' })).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Título').value).toBe('Título mantido');
  });

  it('[Permissão] só TEMPLATE_VIEW: campos somente leitura e sem ações de edição', async () => {
    mockApi(
      {
        getVersion: () =>
          jsonResponse({
            data: version({
              sections: [
                {
                  key: 'OBJETO',
                  title: 'Objeto',
                  order: 1,
                  requirement: 'REQUIRED',
                  maxChars: 50_000,
                  render: 'TEXT',
                  allowNarrative: true,
                },
              ],
            }),
          }),
      },
      ['TEMPLATE_VIEW'],
    );
    renderWithShell(<TemplateEditorView versionId={VERSION_ID} />);
    expect(
      await screen.findByText(
        'Você pode consultar este template, mas não tem permissão para editá-lo.',
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Chave').readOnly).toBe(true);
    expect(screen.queryByRole('button', { name: 'Adicionar seção' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Salvar alterações' })).toBeNull();
  });

  it('FA-05: versão publicada abre em modo leitura com o aviso', async () => {
    mockApi({
      getVersion: () => jsonResponse({ data: version({ status: 'PUBLISHED', publishedAt: NOW }) }),
    });
    renderWithShell(<TemplateEditorView versionId={VERSION_ID} />);
    expect(
      await screen.findByText('Esta versão está publicada. Para alterar, inicie uma nova versão.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Adicionar seção' })).toBeNull();
  });

  it('TR: campos do cabeçalho e mapeamento de importação editáveis', async () => {
    const api = mockApi({
      getVersion: () =>
        jsonResponse({
          data: version({
            templateName: 'TR padrão',
            documentType: TR_TYPE,
            importMappings: DEFAULT_TR_IMPORT_MAPPINGS,
            importSources: {
              sectionKeys: ['RECOMMENDED_SOLUTION', 'REQUIREMENTS'],
              fieldKeys: ['estimatedTotalValue'],
            },
            sections: [
              {
                key: 'OBJECT',
                title: 'Objeto',
                order: 1,
                requirement: 'REQUIRED',
                maxChars: 50_000,
                render: 'TEXT',
                allowNarrative: true,
              },
            ],
          }),
        }),
      patch: (_url, init) =>
        jsonResponse({ data: version({ documentType: TR_TYPE, ...bodyOf(init), version: 4 }) }),
    });
    renderWithShell(<TemplateEditorView versionId={VERSION_ID} />);
    await userEvent.type(
      await screen.findByLabelText('Rótulo de objectDefinition'),
      'Objeto da contratação',
    );
    await userEvent.click(screen.getByLabelText('objectDefinition obrigatório'));
    expect(screen.getByRole('heading', { name: 'Importação do ETP' })).toBeTruthy();
    await userEvent.click(
      screen.getByRole('button', { name: 'Remover o mapeamento de JUSTIFICATION' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }));
    await waitFor(() => {
      expect(callsTo(api, 'PATCH')).toHaveLength(1);
    });
    const body = bodyOf(callsTo(api, 'PATCH')[0]?.[1]) as {
      fieldConfig: Record<string, unknown>;
      importMappings: { sections: { target: string }[] };
    };
    expect(body.fieldConfig).toEqual({
      objectDefinition: { label: 'Objeto da contratação', required: true },
    });
    expect(body.importMappings.sections.map((mapping) => mapping.target)).toEqual([
      'OBJECT',
      'SPECIFICATIONS',
      'ESTIMATED_VALUE',
    ]);
    expect(body).not.toHaveProperty('sections');
  });

  it('versão inexistente ou de outro tenant → "não encontrada"', async () => {
    mockApi({ getVersion: () => problemResponse(404, 'NOT_FOUND', 'x') });
    renderWithShell(<TemplateEditorView versionId={VERSION_ID} />);
    expect(await screen.findByText('Versão do template não encontrada.')).toBeTruthy();
  });
});
