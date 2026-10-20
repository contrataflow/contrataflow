// @vitest-environment jsdom
import type { DocumentTypeDto } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { DocumentTypesView } from './document-types-view';

// A suíte completa roda em paralelo com as demais; o padrão de 1 s é curto para a primeira renderização.
configure({ asyncUtilTimeout: 5000 });
// Sob a carga do `turbo run test`, digitar o formulário inteiro passa dos 5 s padrão do vitest.
vi.setConfig({ testTimeout: 30_000 });

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => '/admin/tipos-documento',
}));

const ALL_EDITABLE = [
  'name',
  'description',
  'allowMultiplePerProcess',
  'numberingEnabled',
  'numberingMask',
  'requiresApproval',
  'approvalPolicy',
  'defaultConfidentiality',
  'sortOrder',
  'isActive',
] as const;
const SYSTEM_EDITABLE = ALL_EDITABLE.filter((field) => field !== 'allowMultiplePerProcess');
const STRUCTURED_EDITABLE = SYSTEM_EDITABLE.filter((field) => field !== 'isActive');

let sequence = 0;
function type(overrides: Partial<DocumentTypeDto>): DocumentTypeDto {
  sequence += 1;
  return {
    id: `0192a000-0000-7000-8000-${String(sequence).padStart(12, '0')}`,
    code: 'OFICIO',
    name: 'Ofício',
    description: null,
    kind: 'FREE_TEXT',
    systemModule: null,
    isSystem: true,
    isActive: true,
    allowMultiplePerProcess: true,
    numberingEnabled: true,
    numberingMask: 'OF {seq:4}/{year}',
    nextNumberPreview: 'OF 0001/2026',
    requiresApproval: false,
    approvalPolicy: null,
    defaultConfidentiality: 'INTERNAL',
    defaultTemplate: null,
    sortOrder: 70,
    editableFields: [...SYSTEM_EDITABLE],
    version: 1,
    ...overrides,
  };
}

const DFD = type({
  code: 'DFD',
  name: 'Documento de Formalização da Demanda',
  kind: 'STRUCTURED',
  systemModule: 'DFD',
  allowMultiplePerProcess: false,
  numberingMask: null,
  nextNumberPreview: 'DFD 0001/2026',
  sortOrder: 10,
  editableFields: [...STRUCTURED_EDITABLE],
});
const OFICIO = type({});
const PARECER = type({
  code: 'PARECER_TECNICO',
  name: 'Parecer técnico',
  isSystem: false,
  numberingMask: 'PT {seq:3}/{year}',
  nextNumberPreview: 'PT 001/2026',
  sortOrder: 0,
  editableFields: [...ALL_EDITABLE],
});
const EXTERNO = type({
  code: 'DOCUMENTO_EXTERNO',
  name: 'Documento externo',
  kind: 'UPLOADED',
  numberingEnabled: false,
  numberingMask: null,
  nextNumberPreview: null,
  sortOrder: 110,
});
const INATIVO = type({
  code: 'PORTARIA',
  name: 'Portaria',
  isSystem: false,
  isActive: false,
  nextNumberPreview: 'PORT 0001/2026',
  editableFields: [...ALL_EDITABLE],
});

const CATALOG = [DFD, PARECER, OFICIO, INATIVO, EXTERNO];

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
      instance: '/api/v1/document-types',
      code,
      correlationId: 'c-test',
      errors,
      violations: [],
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function mockApi(routes: { list?: Handler; post?: Handler; patch?: Handler } = {}) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/v1/me/permissions')) {
      return Promise.resolve(
        jsonResponse({ data: { permissions: [{ code: 'DOCUMENT_TYPE_MANAGE', scopes: [] }] } }),
      );
    }
    if (method === 'GET' && url.startsWith('/api/v1/document-types')) {
      return Promise.resolve(
        (routes.list ?? (() => jsonResponse({ data: CATALOG, meta: {} })))(url, init),
      );
    }
    if (method === 'POST' && url === '/api/v1/document-types') {
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
  return { url: requestUrl(call[0]), init: call[1] };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[Sucesso] SCR-108 lista os tipos agrupados por natureza', () => {
  it('mostra os grupos, a situação, a prévia de numeração, "Do sistema" e as ações permitidas', async () => {
    const api = mockApi();
    renderWithShell(<DocumentTypesView />);

    expect(await screen.findByRole('heading', { name: 'Estruturado' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Texto livre' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Arquivo externo' })).toBeTruthy();
    expect(
      api.mock.calls.some(
        ([url]) => requestUrl(url) === '/api/v1/document-types?includeInactive=true',
      ),
    ).toBe(true);

    const structured = screen.getByRole('table', { name: 'Tipos de documento — Estruturado' });
    expect(within(structured).getByText('Do sistema')).toBeTruthy();
    expect(within(structured).getByText('Próximo: DFD 0001/2026')).toBeTruthy();
    // Estruturado nunca se desativa (RN-DOC-04).
    expect(within(structured).queryByRole('button', { name: /Desativar/ })).toBeNull();

    const free = screen.getByRole('table', { name: 'Tipos de documento — Texto livre' });
    expect(within(free).getByText('Próximo: PT 001/2026')).toBeTruthy();
    expect(within(free).getAllByText('Sem template publicado').length).toBeGreaterThan(0);
    expect(within(free).getByText('Inativo')).toBeTruthy();
    expect(within(free).getByRole('button', { name: 'Reativar Portaria' })).toBeTruthy();
    expect(within(free).getByRole('button', { name: 'Desativar Ofício' })).toBeTruthy();

    const uploaded = screen.getByRole('table', { name: 'Tipos de documento — Arquivo externo' });
    expect(within(uploaded).getByText('Sem numeração')).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('estado de carregamento acessível enquanto a lista não chega', async () => {
    mockApi({ list: () => new Promise<Response>(() => undefined) });
    renderWithShell(<DocumentTypesView />);
    expect((await screen.findByRole('status')).textContent).toContain('Carregando os tipos');
    expect(screen.queryByRole('button', { name: 'Novo tipo' })).toBeNull();
  });
});

describe('[Permissão] sem DOCUMENT_TYPE_MANAGE a API responde 403', () => {
  it('mostra "Acesso negado" no lugar da tela, sem ações de gestão', async () => {
    mockApi({ list: () => problemResponse(403, 'PERMISSION_DENIED', 'Você não tem permissão.') });
    renderWithShell(<DocumentTypesView />);
    expect(await screen.findByText('Acesso negado')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Novo tipo' })).toBeNull();
  });

  it('falha de carga (4xx diferente de 403) oferece tentar novamente', async () => {
    mockApi({ list: () => problemResponse(429, 'RATE_LIMITED', 'Muitas tentativas.') });
    renderWithShell(<DocumentTypesView />);
    expect(await screen.findByText('Não foi possível carregar os tipos.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeTruthy();
  });
});

describe('[Validação] criação de tipo', () => {
  async function openCreate() {
    const api = mockApi({
      post: () =>
        jsonResponse(
          { data: { ...PARECER, id: '0192a000-0000-7000-8000-0000000000f1', version: 1 } },
          { status: 201, headers: { ETag: '"1"' } },
        ),
    });
    renderWithShell(<DocumentTypesView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Novo tipo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Novo tipo de documento' });
    return { api, dialog };
  }

  it('sugere o código a partir do nome e o mantém depois de editado', async () => {
    const { dialog } = await openCreate();
    const name = within(dialog).getByLabelText('Nome');
    const code = within(dialog).getByLabelText<HTMLInputElement>('Código');
    await userEvent.type(name, 'Parecer técnico');
    expect(code.value).toBe('PARECER_TECNICO');
    await userEvent.clear(code);
    await userEvent.type(code, 'PARECER_X');
    await userEvent.type(name, ' jurídico');
    expect(code.value).toBe('PARECER_X');
  });

  it('campos obrigatórios e máscara inválida: erros em pt-BR e nada é enviado', async () => {
    const { api, dialog } = await openCreate();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(
      await within(dialog).findAllByText(
        /Informe ao menos 3 caracteres|Campo obrigatório|Informe o código/,
      ),
    ).not.toHaveLength(0);

    await userEvent.type(within(dialog).getByLabelText('Nome'), 'Parecer técnico');
    await userEvent.type(within(dialog).getByLabelText('Máscara de numeração'), 'PT {{seq:3}');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(
      await within(dialog).findByText(
        'A máscara deve conter {seq:N} e {year} e usar apenas os campos permitidos.',
      ),
    ).toBeTruthy();
    expect(within(dialog).getByLabelText('Máscara de numeração').getAttribute('aria-invalid')).toBe(
      'true',
    );
    expect(callsTo(api, 'POST')).toHaveLength(0);
  });

  it('aprovação avulsa liga o bloco "Quem aprova" e exige prazo válido', async () => {
    const { api, dialog } = await openCreate();
    expect(within(dialog).queryByText('Quem aprova')).toBeNull();
    await userEvent.type(within(dialog).getByLabelText('Nome'), 'Parecer técnico');
    await userEvent.click(within(dialog).getByLabelText('Exige aprovação avulsa'));
    const approver = within(dialog).getByRole('group', { name: 'Quem aprova' });
    // Usuário e perfil dependem dos cadastros (seletores USR-02/ROL-02): ficam desabilitados.
    const type = within(approver).getByLabelText('Tipo de aprovador');
    expect(
      within(type)
        .getByRole('option', { name: /Usuário/ })
        .hasAttribute('disabled'),
    ).toBe(true);
    await userEvent.type(within(approver).getByLabelText('Prazo da aprovação (dias)'), '400');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(await within(dialog).findByText('O prazo deve estar entre 1 e 365 dias.')).toBeTruthy();
    expect(callsTo(api, 'POST')).toHaveLength(0);
  });
});

describe('[Sucesso] criar tipo envia DTY-02 com Idempotency-Key', () => {
  it('corpo validado pelo schema da API, chave de idempotência e lista relida', async () => {
    const api = mockApi({
      post: () =>
        jsonResponse(
          { data: { ...PARECER, version: 1 } },
          { status: 201, headers: { ETag: '"1"' } },
        ),
    });
    renderWithShell(<DocumentTypesView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Novo tipo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Novo tipo de documento' });
    await userEvent.type(within(dialog).getByLabelText('Nome'), 'Parecer técnico');
    await userEvent.type(
      within(dialog).getByLabelText('Máscara de numeração'),
      'PT {{seq:3}/{{year}',
    );
    expect(
      within(dialog).getByText('Prévia: PT 001/' + String(new Date().getFullYear())),
    ).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => {
      expect(callsTo(api, 'POST')).toHaveLength(1);
    });
    const { url, init } = callOf(api, 'POST');
    expect(url).toBe('/api/v1/document-types');
    expect(new Headers(init?.headers).get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(bodyOf(init)).toEqual({
      kind: 'FREE_TEXT',
      code: 'PARECER_TECNICO',
      name: 'Parecer técnico',
      allowMultiplePerProcess: true,
      numberingEnabled: true,
      numberingMask: 'PT {seq:3}/{year}',
      requiresApproval: false,
      defaultConfidentiality: 'INTERNAL',
      sortOrder: 0,
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    // Invalida a lista: segunda leitura de DTY-01.
    await waitFor(() => {
      expect(
        callsTo(api, 'GET').filter(([url]) => requestUrl(url).includes('document-types')).length,
      ).toBeGreaterThan(1);
    });
  });

  it('aprovação avulsa com titular da secretaria solicitante, substituto e 3 dias úteis', async () => {
    const api = mockApi({ post: () => jsonResponse({ data: PARECER }, { status: 201 }) });
    renderWithShell(<DocumentTypesView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Novo tipo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Novo tipo de documento' });
    await userEvent.type(within(dialog).getByLabelText('Nome'), 'Nota de aprovação');
    await userEvent.click(within(dialog).getByLabelText('Exige aprovação avulsa'));
    await userEvent.type(within(dialog).getByLabelText('Prazo da aprovação (dias)'), '3');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => {
      expect(callsTo(api, 'POST')).toHaveLength(1);
    });
    expect(bodyOf(callOf(api, 'POST').init).approvalPolicy).toEqual({
      approverType: 'DEPARTMENT_HEAD',
      approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
      allowDeputy: true,
      slaDays: 3,
      slaType: 'BUSINESS',
    });
  });
});

describe('[Duplicidade] erros do servidor voltam para os campos', () => {
  async function submitCreate(response: () => Response) {
    const api = mockApi({ post: response });
    renderWithShell(<DocumentTypesView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Novo tipo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Novo tipo de documento' });
    await userEvent.type(within(dialog).getByLabelText('Nome'), 'Parecer técnico');
    await userEvent.type(
      within(dialog).getByLabelText('Máscara de numeração'),
      'PT {{seq:3}/{{year}',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    return { api, dialog };
  }

  it('código já usado (409 CONFLICT) marca o campo código', async () => {
    const { dialog } = await submitCreate(() =>
      problemResponse(409, 'CONFLICT', 'Já existe um tipo com o código PARECER_TECNICO.'),
    );
    expect(
      await within(dialog).findByText('Já existe um tipo com o código PARECER_TECNICO.'),
    ).toBeTruthy();
    expect(within(dialog).getByLabelText('Código').getAttribute('aria-invalid')).toBe('true');
  });

  it('NUMBERING_MASK_INVALID do servidor marca a máscara', async () => {
    const { dialog } = await submitCreate(() =>
      problemResponse(422, 'NUMBERING_MASK_INVALID', 'A máscara é inválida.', [
        { field: 'numberingMask', code: 'INVALID_FORMAT', message: 'A máscara é inválida.' },
      ]),
    );
    expect(
      await within(dialog).findByText(
        'A máscara deve conter {seq:N} e {year} e usar apenas os campos permitidos.',
      ),
    ).toBeTruthy();
  });

  it('banco indisponível (503): mantém os dados preenchidos e mostra a mensagem', async () => {
    const { dialog } = await submitCreate(() =>
      problemResponse(503, 'DEPENDENCY_UNAVAILABLE', 'Indisponível.'),
    );
    expect(
      await screen.findByText(
        'Não foi possível salvar agora. Tente novamente em instantes.',
        undefined,
        { timeout: 5000 },
      ),
    ).toBeTruthy();
    expect(within(dialog).getByLabelText<HTMLInputElement>('Nome').value).toBe('Parecer técnico');
  }, 15_000);
});

describe('[Sucesso] edição de tipo de sistema', () => {
  async function openEdit(name: RegExp, routes: Parameters<typeof mockApi>[0] = {}) {
    const api = mockApi(routes);
    renderWithShell(<DocumentTypesView />);
    await userEvent.click(await screen.findByRole('button', { name }));
    return { api, dialog: await screen.findByRole('dialog') };
  }

  it('campos restritos aparecem como texto com cadeado e "Definido pela plataforma"', async () => {
    const { dialog } = await openEdit(/^Editar Documento de Formalização/);
    expect(within(dialog).getAllByText('Definido pela plataforma').length).toBeGreaterThanOrEqual(
      3,
    );
    expect(within(dialog).getByText('DFD')).toBeTruthy();
    // Código imutável: sem campo editável.
    expect(within(dialog).queryByLabelText('Código')).toBeNull();
    // Estruturado: "Permite vários por processo" é restrito.
    expect(within(dialog).queryByLabelText('Permite vários por processo')).toBeNull();
    expect(within(dialog).getByLabelText('Nome')).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('envia só o campo alterado, com If-Match da versão lida', async () => {
    const { api, dialog } = await openEdit(/^Editar Ofício/, {
      patch: () =>
        jsonResponse(
          { data: { ...OFICIO, name: 'Ofício externo', version: 2 } },
          { headers: { ETag: '"2"' } },
        ),
    });
    const name = within(dialog).getByLabelText('Nome');
    await userEvent.clear(name);
    await userEvent.type(name, 'Ofício externo');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => {
      expect(callsTo(api, 'PATCH')).toHaveLength(1);
    });
    const { url, init } = callOf(api, 'PATCH');
    expect(url).toBe(`/api/v1/document-types/${OFICIO.id}`);
    expect(new Headers(init?.headers).get('If-Match')).toBe('"1"');
    expect(bodyOf(init)).toEqual({ name: 'Ofício externo' });
  });

  it('alterar a máscara avisa que a sequência continua; liga a aprovação e envia a política', async () => {
    const { api, dialog } = await openEdit(/^Editar Ofício/, {
      patch: () => jsonResponse({ data: { ...OFICIO, requiresApproval: true, version: 2 } }),
    });
    expect(
      within(dialog).getByText('A sequência continua e os números já emitidos não mudam.'),
    ).toBeTruthy();
    await userEvent.click(within(dialog).getByLabelText('Exige aprovação avulsa'));
    expect(within(dialog).getByText(/documentos já finalizados não são alterados/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => {
      expect(callsTo(api, 'PATCH')).toHaveLength(1);
    });
    expect(bodyOf(callOf(api, 'PATCH').init)).toEqual({
      requiresApproval: true,
      approvalPolicy: {
        approverType: 'DEPARTMENT_HEAD',
        approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
        allowDeputy: true,
      },
    });
  });

  it('sem alterações: fecha sem chamar a API', async () => {
    const { api, dialog } = await openEdit(/^Editar Ofício/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(callsTo(api, 'PATCH')).toHaveLength(0);
  });
});

describe('[Concorrência] versão desatualizada (412)', () => {
  it('oferece "Recarregar e reaplicar minhas alterações" e reaplica só o que a pessoa mudou', async () => {
    let patchCalls = 0;
    let listCalls = 0;
    const fresh = { ...OFICIO, name: 'Ofício (Otávio)', version: 4 };
    const api = mockApi({
      list: () => {
        listCalls += 1;
        return jsonResponse({ data: listCalls === 1 ? CATALOG : [DFD, fresh, PARECER] });
      },
      patch: () => {
        patchCalls += 1;
        return patchCalls === 1
          ? problemResponse(412, 'VERSION_CONFLICT', 'O registro foi alterado por outra pessoa.')
          : jsonResponse({ data: { ...fresh, numberingMask: 'OFX {seq:4}/{year}', version: 5 } });
      },
    });
    renderWithShell(<DocumentTypesView />);
    await userEvent.click(await screen.findByRole('button', { name: /^Editar Ofício/ }));
    const dialog = await screen.findByRole('dialog');
    const mask = within(dialog).getByLabelText('Máscara de numeração');
    await userEvent.clear(mask);
    await userEvent.type(mask, 'OFX {{seq:4}/{{year}');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    expect(await within(dialog).findByText('Este tipo foi alterado por outra pessoa')).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Recarregar e reaplicar minhas alterações' }),
    );
    // O nome da versão nova (de Otávio) aparece; a máscara digitada foi mantida.
    await waitFor(() => {
      expect(within(dialog).getByLabelText<HTMLInputElement>('Nome').value).toBe('Ofício (Otávio)');
    });
    expect(within(dialog).getByLabelText<HTMLInputElement>('Máscara de numeração').value).toBe(
      'OFX {seq:4}/{year}',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => {
      expect(callsTo(api, 'PATCH')).toHaveLength(2);
    });
    const retry = callOf(api, 'PATCH', 1).init;
    expect(new Headers(retry?.headers).get('If-Match')).toBe('"4"');
    expect(bodyOf(retry)).toEqual({ numberingMask: 'OFX {seq:4}/{year}' });
  });
});

describe('[Sucesso] desativar e reativar', () => {
  it('desativar pede confirmação e envia { isActive: false } com If-Match', async () => {
    const api = mockApi({
      patch: () => jsonResponse({ data: { ...OFICIO, isActive: false, version: 2 } }),
    });
    renderWithShell(<DocumentTypesView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Desativar Ofício' }));
    const dialog = await screen.findByRole('dialog', { name: 'Desativar Ofício?' });
    expect(within(dialog).getByText(/Os documentos existentes continuam acessíveis/)).toBeTruthy();
    expect(callsTo(api, 'PATCH')).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Desativar' }));
    await waitFor(() => {
      expect(callsTo(api, 'PATCH')).toHaveLength(1);
    });
    const { init } = callOf(api, 'PATCH');
    expect(new Headers(init?.headers).get('If-Match')).toBe('"1"');
    expect(bodyOf(init)).toEqual({ isActive: false });
  });

  it('bloqueio por fluxo publicado (409) mostra a mensagem da API e o tipo continua ativo', async () => {
    mockApi({
      patch: () =>
        problemResponse(
          409,
          'CONFLICT',
          'Este tipo é exigido pelo fluxo Fase preparatória (etapa Termo de Referência). Ajuste o fluxo antes de desativar.',
        ),
    });
    renderWithShell(<DocumentTypesView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Desativar Parecer técnico' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Desativar' }));
    expect(await within(dialog).findByText(/exigido pelo fluxo Fase preparatória/)).toBeTruthy();
  });

  it('reativar envia { isActive: true } sem confirmação', async () => {
    const api = mockApi({
      patch: () => jsonResponse({ data: { ...INATIVO, isActive: true, version: 2 } }),
    });
    renderWithShell(<DocumentTypesView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Reativar Portaria' }));
    await waitFor(() => {
      expect(callsTo(api, 'PATCH')).toHaveLength(1);
    });
    expect(bodyOf(callOf(api, 'PATCH').init)).toEqual({ isActive: true });
  });
});
