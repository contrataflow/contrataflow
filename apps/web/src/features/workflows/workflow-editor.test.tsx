// @vitest-environment jsdom
import { Toaster } from '@contrataflow/ui';
import type {
  WorkflowDto,
  WorkflowStageDto,
  WorkflowTransitionDto,
  WorkflowVersionDetailDto,
} from '@contrataflow/validation';
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { WorkflowEditorView } from './workflow-editor';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/workflows/x',
}));

const WORKFLOW_ID = '0192a000-0000-7000-8000-000000000043';
const DRAFT_ID = '0192a000-0000-7000-8000-0000000000d1';
const PUBLISHED_ID = '0192a000-0000-7000-8000-0000000000e1';
const MANAGE = ['WORKFLOW_VIEW', 'WORKFLOW_MANAGE'];

let sequence = 0;
const nextId = () => {
  sequence += 1;
  return `0192a000-0000-7000-8000-${String(sequence).padStart(12, '0')}`;
};

function stageOf(overrides: Partial<WorkflowStageDto>): WorkflowStageDto {
  return {
    id: nextId(),
    workflowVersionId: DRAFT_ID,
    key: 'ETAPA',
    name: 'Etapa',
    instructions: null,
    type: 'TASK',
    groupLabel: null,
    displayOrder: 0,
    departmentResolution: 'REQUESTING_DEPARTMENT',
    fixedDepartmentId: null,
    assignmentPolicy: 'UNASSIGNED',
    approverType: null,
    approverUserId: null,
    approverRoleId: null,
    approverDepartmentResolution: null,
    approverFixedDepartmentId: null,
    allowDeputy: true,
    approvalDocumentTypeCodes: [],
    documentTypeCodes: [],
    slaDays: null,
    slaType: 'BUSINESS',
    color: null,
    version: 1,
    ...overrides,
  };
}

function problem(status: number, code: string, extra: object = {}): Response {
  return new Response(
    JSON.stringify({
      type: `https://docs.contrataflow.com.br/errors/${code.toLowerCase()}`,
      title: code,
      status,
      detail: code,
      instance: '/api/v1/x',
      code,
      correlationId: 'c-test',
      errors: [],
      violations: [],
      ...extra,
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

interface State {
  workflow: WorkflowDto;
  versions: Map<string, WorkflowVersionDetailDto>;
}

function version(
  id: string,
  status: 'DRAFT' | 'PUBLISHED',
  number: number,
): WorkflowVersionDetailDto {
  return {
    id,
    workflowId: WORKFLOW_ID,
    versionNumber: number,
    status,
    changeNotes: null,
    publishedAt: null,
    publishedById: null,
    retiredAt: null,
    retiredById: null,
    definitionHash: null,
    createdAt: '2026-10-16T12:00:00.000Z',
    createdById: null,
    version: 1,
    initialStageId: null,
    stages: [],
    transitions: [],
    rules: [],
  };
}

function initialState(kind: 'draft' | 'published' = 'draft'): State {
  const workflow: WorkflowDto = {
    id: WORKFLOW_ID,
    key: 'OBRAS_RITO_SIMPLIFICADO',
    name: 'Obras — rito simplificado',
    description: null,
    isActive: true,
    isDefault: false,
    applicabilityRule: null,
    applicabilityPriority: 100,
    currentPublishedVersion:
      kind === 'published' ? { id: PUBLISHED_ID, versionNumber: 1, publishedAt: null } : null,
    draftVersion: kind === 'draft' ? { id: DRAFT_ID, versionNumber: 1 } : null,
    version: 1,
  };
  const versions = new Map<string, WorkflowVersionDetailDto>();
  if (kind === 'draft') versions.set(DRAFT_ID, version(DRAFT_ID, 'DRAFT', 1));
  else {
    const published = version(PUBLISHED_ID, 'PUBLISHED', 1);
    versions.set(PUBLISHED_ID, {
      ...published,
      stages: [
        stageOf({
          workflowVersionId: PUBLISHED_ID,
          key: 'ABERTURA',
          name: 'Abertura',
          type: 'START',
          version: undefined,
        }),
      ],
    });
  }
  return { workflow, versions };
}

type Override = (url: string, init: RequestInit | undefined, state: State) => Response | null;

function mockApi(
  state: State,
  options: { permissions?: readonly string[]; override?: Override } = {},
) {
  const permissions = options.permissions ?? MANAGE;
  const draft = () => {
    const found = state.versions.get(state.workflow.draftVersion?.id ?? '');
    if (!found) throw new Error('rascunho ausente');
    return found;
  };
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    const overridden = options.override?.(url, init, state);
    if (overridden) return Promise.resolve(overridden);
    if (url.startsWith('/api/v1/me/permissions')) {
      return Promise.resolve(
        jsonResponse({ data: { permissions: permissions.map((code) => ({ code, scopes: [] })) } }),
      );
    }
    if (url.startsWith('/api/v1/document-types')) {
      return Promise.resolve(
        jsonResponse({
          data: [
            {
              id: nextId(),
              code: 'DFD',
              name: 'Documento de formalização da demanda',
              isActive: true,
            },
          ],
        }),
      );
    }
    if (method === 'GET' && url === `/api/v1/workflows/${WORKFLOW_ID}`) {
      return Promise.resolve(jsonResponse({ data: state.workflow }));
    }
    const versionMatch = /^\/api\/v1\/workflow-versions\/([^/]+)$/.exec(url);
    if (method === 'GET' && versionMatch) {
      const found = state.versions.get(versionMatch[1] ?? '');
      return Promise.resolve(found ? jsonResponse({ data: found }) : problem(404, 'NOT_FOUND'));
    }
    if (method === 'POST' && url === `/api/v1/workflow-versions/${DRAFT_ID}/stages`) {
      const created = stageOf({
        ...(body as Partial<WorkflowStageDto>),
        workflowVersionId: DRAFT_ID,
        version: 1,
      });
      const current = draft();
      state.versions.set(DRAFT_ID, { ...current, stages: [...current.stages, created] });
      return Promise.resolve(jsonResponse({ data: created }, { status: 201 }));
    }
    const stageMatch = /^\/api\/v1\/workflow-stages\/([^/]+)$/.exec(url);
    if (stageMatch && (method === 'PATCH' || method === 'DELETE')) {
      const current = draft();
      const target = current.stages.find((item) => item.id === stageMatch[1]);
      if (!target) return Promise.resolve(problem(404, 'NOT_FOUND'));
      const ifMatch = new Headers(init?.headers).get('If-Match');
      if (ifMatch !== `"${String(target.version)}"`)
        return Promise.resolve(problem(412, 'VERSION_CONFLICT'));
      if (method === 'DELETE') {
        state.versions.set(DRAFT_ID, {
          ...current,
          stages: current.stages.filter((item) => item !== target),
        });
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      const updated = {
        ...target,
        ...body,
        version: (target.version ?? 1) + 1,
      } as WorkflowStageDto;
      state.versions.set(DRAFT_ID, {
        ...current,
        stages: current.stages.map((item) => (item === target ? updated : item)),
      });
      return Promise.resolve(jsonResponse({ data: updated }));
    }
    if (method === 'POST' && url === `/api/v1/workflow-versions/${DRAFT_ID}/transitions`) {
      const created = {
        ...(body as unknown as WorkflowTransitionDto),
        id: nextId(),
        workflowVersionId: DRAFT_ID,
        description: null,
        version: 1,
      };
      const current = draft();
      state.versions.set(DRAFT_ID, { ...current, transitions: [...current.transitions, created] });
      return Promise.resolve(jsonResponse({ data: created }, { status: 201 }));
    }
    return Promise.resolve(problem(404, 'NOT_FOUND'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const calls = (fetchMock: ReturnType<typeof mockApi>, method: string, fragment: string) =>
  fetchMock.mock.calls.filter(
    ([input, init]) => (init?.method ?? 'GET') === method && requestUrl(input).includes(fragment),
  );

function renderEditor() {
  return renderWithShell(
    <>
      <WorkflowEditorView workflowId={WORKFLOW_ID} />
      <Toaster />
    </>,
  );
}

/** Escolhe uma opção num seletor do kit (Radix Select). */
async function choose(scope: HTMLElement, field: string, option: string) {
  await userEvent.click(within(scope).getByRole('combobox', { name: field }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

async function addStage(name: string, type: string) {
  await userEvent.click(await screen.findByRole('button', { name: 'Adicionar etapa' }));
  const panel = await screen.findByRole('region', { name: 'Nova etapa' });
  await userEvent.type(within(panel).getByLabelText('Nome'), name);
  await choose(panel, 'Tipo', type);
  await userEvent.click(within(panel).getByRole('button', { name: 'Adicionar etapa' }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SCR-034 · editor de workflow (US-043)', () => {
  it('[Sucesso] adiciona etapas (chave gerada pelo nome) e uma transição; sem violações de a11y', async () => {
    const state = initialState();
    const api = mockApi(state);
    renderEditor();

    expect(await screen.findByText('Nenhuma etapa ainda — adicione a primeira.')).toBeTruthy();
    await addStage('Abertura', 'Início');
    await screen.findByRole('button', { name: 'Abrir as propriedades de Abertura' });
    await addStage('Parecer jurídico', 'Tarefa');
    await screen.findByRole('button', { name: 'Abrir as propriedades de Parecer jurídico' });

    const posted = calls(api, 'POST', '/stages').map(
      ([, init]) => JSON.parse(init?.body as string) as Record<string, unknown>,
    );
    expect(posted.map((body) => [body.key, body.type, body.displayOrder])).toEqual([
      ['ABERTURA', 'START', 0],
      ['PARECER_JURIDICO', 'TASK', 1],
    ]);

    await userEvent.click(screen.getByRole('tab', { name: 'Transições' }));
    await userEvent.click(screen.getByRole('button', { name: 'Adicionar transição' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nova transição' });
    await userEvent.type(
      within(dialog).getByLabelText('Rótulo do botão'),
      'Encaminhar para o jurídico',
    );
    await choose(dialog, 'Etapa de origem', 'Abertura');
    await choose(dialog, 'Etapa de destino', 'Parecer jurídico');
    // Aprovar e indeferir vêm das etapas de aprovação: não são opções do formulário.
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Ação' }));
    expect(await screen.findByRole('option', { name: 'Encaminhar' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Aprovar' })).toBeNull();
    await userEvent.click(screen.getByRole('option', { name: 'Encaminhar' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Adicionar transição' }));

    expect(await screen.findByText('Abertura → Parecer jurídico')).toBeTruthy();
    const transitionBody = JSON.parse(
      calls(api, 'POST', '/transitions')[0]?.[1]?.body as string,
    ) as Record<string, unknown>;
    expect(transitionBody).toMatchObject({ key: 'ENCAMINHAR_PARA_O_JURIDICO', action: 'FORWARD' });
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('[Validação] aprovação sem aprovador mostra "Selecione quem aprova esta etapa." sem chamar a API', async () => {
    const api = mockApi(initialState());
    renderEditor();
    await addStage('Aprovação da autoridade', 'Aprovação');
    expect(await screen.findByText('Selecione quem aprova esta etapa.')).toBeTruthy();
    expect(calls(api, 'POST', '/stages')).toHaveLength(0);
  });

  it('[Validação] avisos do grafo (sem saída/inalcançável) aparecem sem bloquear', async () => {
    const state = initialState();
    const start = stageOf({ key: 'ABERTURA', name: 'Abertura', type: 'START', displayOrder: 0 });
    const loose = stageOf({ key: 'SOLTA', name: 'Solta', displayOrder: 1 });
    state.versions.set(DRAFT_ID, { ...version(DRAFT_ID, 'DRAFT', 1), stages: [start, loose] });
    mockApi(state);
    renderEditor();
    const warnings = await screen.findByRole('region', { name: 'Avisos do fluxo' });
    expect(within(warnings).getByText('A etapa Abertura não tem transição de saída.')).toBeTruthy();
    expect(
      within(warnings).getByText('A etapa Solta não é alcançável a partir do início.'),
    ).toBeTruthy();
  });

  it('[Permissão] só WORKFLOW_VIEW: sem "Adicionar etapa"/"Adicionar transição", painel só leitura', async () => {
    const state = initialState();
    const start = stageOf({ key: 'ABERTURA', name: 'Abertura', type: 'START' });
    state.versions.set(DRAFT_ID, { ...version(DRAFT_ID, 'DRAFT', 1), stages: [start] });
    mockApi(state, { permissions: ['WORKFLOW_VIEW'] });
    renderEditor();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Abrir as propriedades de Abertura' }),
    );
    const panel = await screen.findByRole('region', { name: 'Etapa Abertura' });
    expect(within(panel).getByLabelText('Nome').matches(':disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Adicionar etapa' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Excluir etapa' })).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: 'Transições' }));
    expect(screen.queryByRole('button', { name: 'Adicionar transição' })).toBeNull();
  });

  it('[Sucesso] salva o campo ao perder o foco (WF-11 com If-Match da etapa)', async () => {
    const state = initialState();
    const start = stageOf({ key: 'ABERTURA', name: 'Abertura', type: 'START', version: 3 });
    state.versions.set(DRAFT_ID, { ...version(DRAFT_ID, 'DRAFT', 1), stages: [start] });
    const api = mockApi(state);
    renderEditor();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Abrir as propriedades de Abertura' }),
    );
    const panel = await screen.findByRole('region', { name: 'Etapa Abertura' });
    const sla = within(panel).getByLabelText('SLA (dias)');
    await userEvent.type(sla, '5');
    fireEvent.blur(sla);
    expect(await within(panel).findByText('Alterações salvas.')).toBeTruthy();
    const [patched] = calls(api, 'PATCH', '/workflow-stages/');
    expect(new Headers(patched?.[1]?.headers).get('If-Match')).toBe('"3"');
    expect(JSON.parse(patched?.[1]?.body as string)).toEqual({ slaDays: 5 });
  });

  it('[Concorrência] 412 no salvamento: "Recarregar e tentar novamente"', async () => {
    const state = initialState();
    const start = stageOf({ key: 'ABERTURA', name: 'Abertura', type: 'START', version: 3 });
    state.versions.set(DRAFT_ID, { ...version(DRAFT_ID, 'DRAFT', 1), stages: [start] });
    const api = mockApi(state, {
      override: (url, init) =>
        init?.method === 'PATCH' && url.includes('/workflow-stages/')
          ? problem(412, 'VERSION_CONFLICT')
          : null,
    });
    renderEditor();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Abrir as propriedades de Abertura' }),
    );
    const panel = await screen.findByRole('region', { name: 'Etapa Abertura' });
    await choose(panel, 'Contagem do SLA', 'Dias corridos');
    expect(
      await screen.findByText('Os dados foram alterados por outra pessoa. Recarregue.'),
    ).toBeTruthy();
    const reads = calls(api, 'GET', `/workflow-versions/${DRAFT_ID}`).length;
    await userEvent.click(screen.getByRole('button', { name: 'Recarregar e tentar novamente' }));
    await waitFor(() => {
      expect(calls(api, 'GET', `/workflow-versions/${DRAFT_ID}`).length).toBeGreaterThan(reads);
    });
  });

  it('[Falha de banco] 503 ao adicionar etapa: mensagem de indisponibilidade, dados mantidos', async () => {
    mockApi(initialState(), {
      override: (url, init) =>
        init?.method === 'POST' && url.endsWith('/stages')
          ? problem(503, 'DEPENDENCY_UNAVAILABLE')
          : null,
    });
    renderEditor();
    await addStage('Parecer jurídico', 'Tarefa');
    expect(
      await screen.findByText('Não foi possível salvar agora. Tente novamente em instantes.'),
    ).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Nome').value).toBe('Parecer jurídico');
  });

  it('[Validação] FA-01: excluir etapa referenciada lista as transições que a usam', async () => {
    const state = initialState();
    const start = stageOf({ key: 'ABERTURA', name: 'Abertura', type: 'START' });
    state.versions.set(DRAFT_ID, { ...version(DRAFT_ID, 'DRAFT', 1), stages: [start] });
    mockApi(state, {
      override: (_url, init) =>
        init?.method === 'DELETE'
          ? problem(422, 'BUSINESS_RULE_VIOLATION', {
              violations: [
                {
                  code: 'REFERENCED_BY_TRANSITION',
                  severity: 'BLOCKING',
                  message: 'Remova primeiro as transições que usam esta etapa.',
                  ruleId: 'RN-WF-50',
                  sectionKey: null,
                  field: null,
                  itemId: 'transition-1',
                  params: {
                    kind: 'TRANSITION',
                    key: 'ENCAMINHAR',
                    name: 'Encaminhar para o jurídico',
                  },
                },
              ],
            })
          : null,
    });
    renderEditor();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Abrir as propriedades de Abertura' }),
    );
    const panel = await screen.findByRole('region', { name: 'Etapa Abertura' });
    await userEvent.click(within(panel).getByRole('button', { name: 'Excluir etapa' }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Excluir' }));
    expect(
      await within(panel).findByText('Remova primeiro as transições que usam esta etapa.'),
    ).toBeTruthy();
    expect(within(panel).getByText('Encaminhar para o jurídico')).toBeTruthy();
  });

  it('[Sucesso] FA-04: reordena pelo teclado com um PATCH por etapa alterada', async () => {
    const state = initialState();
    const first = stageOf({ key: 'ABERTURA', name: 'Abertura', type: 'START', displayOrder: 0 });
    const second = stageOf({ key: 'PARECER', name: 'Parecer', displayOrder: 1 });
    state.versions.set(DRAFT_ID, { ...version(DRAFT_ID, 'DRAFT', 1), stages: [first, second] });
    const api = mockApi(state);
    renderEditor();
    const handle = await screen.findByRole('button', { name: 'Reordenar Parecer (posição 2)' });
    handle.focus();
    await userEvent.keyboard('{ArrowUp}');
    await screen.findByRole('button', { name: 'Reordenar Parecer (posição 1)' });
    const bodies = calls(api, 'PATCH', '/workflow-stages/').map(
      ([, init]) => JSON.parse(init?.body as string) as unknown,
    );
    expect(bodies).toEqual([{ displayOrder: 0 }, { displayOrder: 1 }]);
  });

  it('[Responsivo] abaixo de 768 px o painel da etapa abre em Sheet (dialog) com título e rodapé', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const state = initialState();
    const start = stageOf({ key: 'ABERTURA', name: 'Abertura', type: 'START' });
    state.versions.set(DRAFT_ID, { ...version(DRAFT_ID, 'DRAFT', 1), stages: [start] });
    mockApi(state);
    renderEditor();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Abrir as propriedades de Abertura' }),
    );
    const sheet = await screen.findByRole('dialog', { name: 'Etapa Abertura' });
    expect(within(sheet).getByLabelText('Nome')).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: 'Excluir etapa' })).toBeTruthy();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Fechar o painel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('[Moldura] cabeçalho com trilha, chips de situação e "Mais" com as telas relacionadas', async () => {
    mockApi(initialState());
    renderEditor();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Obras — rito simplificado' }),
    ).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Trilha' })).toBeTruthy();
    expect(await screen.findByText('Rascunho v1')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Mais' }));
    expect(await screen.findByRole('menuitem', { name: 'Regras da versão' })).toBeTruthy();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Versões e publicação' }));
    expect(await screen.findByRole('tab', { name: 'Versões', selected: true })).toBeTruthy();
  });

  it('[Duplicidade] "Criar rascunho" com rascunho existente oferece continuar', async () => {
    const state = initialState('published');
    mockApi(state, {
      override: (url, init) =>
        init?.method === 'POST' && url.endsWith('/versions')
          ? problem(409, 'WORKFLOW_DRAFT_EXISTS', { meta: { draftVersionId: DRAFT_ID } })
          : null,
    });
    renderEditor();
    expect(await screen.findByText(/Esta é a versão publicada/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Adicionar etapa' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Criar rascunho' }));
    expect(
      await screen.findByText('Já existe um rascunho deste workflow. Continue a edição dele.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continuar o rascunho existente' })).toBeTruthy();
  });

  it('[Tenant incorreto] workflow de outro tenant (404): "Workflow não encontrado."', async () => {
    mockApi(initialState(), {
      override: (url) =>
        url === `/api/v1/workflows/${WORKFLOW_ID}` ? problem(404, 'NOT_FOUND') : null,
    });
    renderEditor();
    expect(await screen.findByText('Workflow não encontrado.')).toBeTruthy();
  });
});
