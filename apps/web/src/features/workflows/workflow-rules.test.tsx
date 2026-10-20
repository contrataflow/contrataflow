// @vitest-environment jsdom
import type {
  RuleContextSchemaDto,
  WorkflowDto,
  WorkflowRuleDto,
  WorkflowRuleTestResult,
  WorkflowStageDto,
  WorkflowVersionDetailDto,
} from '@contrataflow/validation';
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { WorkflowRulesView } from './workflow-rules';

/*
 * US-044 — SCR-035 (regras de etapa e de transição): criar regra por tipo, "Testar regra" contra um
 * processo (antes de salvar — FA-03), o construtor de condições, permissões (só WORKFLOW_VIEW),
 * concorrência (412), versão publicada no meio da edição (FA-05), reordenação pelo teclado (FA-01)
 * e a "Falha de integração" do WF-19 (Salvar desabilitado até o schema carregar).
 */

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/workflows/x/regras',
}));

const WORKFLOW_ID = '0192a000-0000-7000-8000-000000000044';
const DRAFT_ID = '0192a000-0000-7000-8000-0000000004d1';
const ESTUDOS_ID = '0192a000-0000-7000-8000-0000000004e1';
const AUTORIDADE_ID = '0192a000-0000-7000-8000-0000000004e2';
const PROCESS_ID = '0192a000-0000-7000-8000-0000000004f1';
const MANAGE = ['WORKFLOW_VIEW', 'WORKFLOW_MANAGE'];

let sequence = 0;
const nextId = () => {
  sequence += 1;
  return `0192a000-0000-7000-8000-${String(sequence).padStart(12, '0')}`;
};

const SCHEMA: RuleContextSchemaDto = {
  version: 1,
  fields: [
    { path: 'process.estimatedValue', label: 'Processo — valor estimado', type: 'number' },
    { path: 'process.modalityCode', label: 'Processo — modalidade', type: 'string' },
    { path: 'documents.ETP.isComplete', label: 'Documento ETP — completo', type: 'boolean' },
  ],
};

function stage(
  id: string,
  key: string,
  name: string,
  type: WorkflowStageDto['type'],
  order: number,
) {
  return {
    id,
    workflowVersionId: DRAFT_ID,
    key,
    name,
    instructions: null,
    type,
    groupLabel: null,
    displayOrder: order,
    departmentResolution: 'REQUESTING_DEPARTMENT',
    fixedDepartmentId: null,
    assignmentPolicy: 'UNASSIGNED',
    approverType: type === 'APPROVAL' ? 'DEPARTMENT_HEAD' : null,
    approverUserId: null,
    approverRoleId: null,
    approverDepartmentResolution: type === 'APPROVAL' ? 'REQUESTING_SECRETARIAT' : null,
    approverFixedDepartmentId: null,
    allowDeputy: true,
    approvalDocumentTypeCodes: [],
    documentTypeCodes: [],
    slaDays: null,
    slaType: 'BUSINESS',
    color: null,
    version: 1,
  } satisfies WorkflowStageDto;
}

function ruleOf(overrides: Partial<WorkflowRuleDto>): WorkflowRuleDto {
  return {
    id: nextId(),
    workflowVersionId: DRAFT_ID,
    scope: 'STAGE_EXIT',
    stageId: ESTUDOS_ID,
    transitionId: null,
    type: 'REQUIRED_DOCUMENT',
    name: 'ETP completo',
    description: null,
    severity: 'BLOCKING',
    config: { documentTypeCode: 'ETP', minStatus: 'COMPLETE' },
    message: 'O ETP deve estar completo.',
    isActive: true,
    displayOrder: 0,
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
  version: WorkflowVersionDetailDto;
}

function initialState(rules: WorkflowRuleDto[] = []): State {
  return {
    workflow: {
      id: WORKFLOW_ID,
      key: 'FASE_PREPARATORIA',
      name: 'Fase preparatória — Lei 14.133/2021',
      description: null,
      isActive: true,
      isDefault: true,
      applicabilityRule: null,
      applicabilityPriority: 100,
      currentPublishedVersion: null,
      draftVersion: { id: DRAFT_ID, versionNumber: 2 },
      version: 1,
    },
    version: {
      id: DRAFT_ID,
      workflowId: WORKFLOW_ID,
      versionNumber: 2,
      status: 'DRAFT',
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
      stages: [
        stage(ESTUDOS_ID, 'ESTUDOS_PRELIMINARES', 'Estudos preliminares', 'TASK', 0),
        stage(AUTORIDADE_ID, 'APROVACAO_AUTORIDADE', 'Aprovação da autoridade', 'APPROVAL', 1),
      ],
      transitions: [],
      rules,
    },
  };
}

type Override = (url: string, method: string, body: Record<string, unknown>) => Response | null;

function mockApi(
  state: State,
  options: {
    permissions?: readonly string[];
    override?: Override;
    testResult?: WorkflowRuleTestResult;
  } = {},
) {
  const permissions = options.permissions ?? MANAGE;
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    const overridden = options.override?.(url, method, body);
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
            { id: nextId(), code: 'ETP', name: 'Estudo técnico preliminar', isActive: true },
            { id: nextId(), code: 'ANTIGO', name: 'Tipo antigo', isActive: false },
          ],
        }),
      );
    }
    if (url.startsWith('/api/v1/rule-context/schema')) {
      return Promise.resolve(jsonResponse({ data: SCHEMA }));
    }
    if (url.startsWith('/api/v1/processes')) {
      return Promise.resolve(
        jsonResponse({
          data: [{ id: PROCESS_ID, code: '0012/2026', internalCode: null, title: 'Notebooks' }],
        }),
      );
    }
    if (method === 'GET' && url === `/api/v1/workflows/${WORKFLOW_ID}`) {
      return Promise.resolve(jsonResponse({ data: state.workflow }));
    }
    if (method === 'GET' && url === `/api/v1/workflow-versions/${DRAFT_ID}`) {
      return Promise.resolve(jsonResponse({ data: state.version }));
    }
    if (method === 'POST' && url === `/api/v1/workflow-versions/${DRAFT_ID}/rules/test`) {
      return Promise.resolve(
        jsonResponse({
          data: options.testResult ?? {
            satisfied: false,
            severity: body.severity,
            message: body.message ?? 'Regra não satisfeita.',
            contextUsed: { 'documents.ETP': { exists: true, status: 'DRAFT' }, matchingCount: 0 },
            warnings: [],
          },
        }),
      );
    }
    if (method === 'POST' && url === `/api/v1/workflow-versions/${DRAFT_ID}/rules`) {
      const created = ruleOf({ ...(body as Partial<WorkflowRuleDto>), id: nextId(), version: 1 });
      state.version = { ...state.version, rules: [...state.version.rules, created] };
      return Promise.resolve(jsonResponse({ data: created }, { status: 201 }));
    }
    const ruleMatch = /^\/api\/v1\/workflow-rules\/([^/]+)$/.exec(url);
    if (ruleMatch && (method === 'PATCH' || method === 'DELETE')) {
      const target = state.version.rules.find((item) => item.id === ruleMatch[1]);
      if (!target) return Promise.resolve(problem(404, 'NOT_FOUND'));
      const ifMatch = new Headers(init?.headers).get('If-Match');
      if (ifMatch !== `"${String(target.version)}"`) {
        return Promise.resolve(problem(412, 'VERSION_CONFLICT'));
      }
      if (method === 'DELETE') {
        state.version = {
          ...state.version,
          rules: state.version.rules.filter((item) => item !== target),
        };
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      const updated = { ...target, ...body, version: (target.version ?? 1) + 1 } as WorkflowRuleDto;
      state.version = {
        ...state.version,
        rules: state.version.rules.map((item) => (item === target ? updated : item)),
      };
      return Promise.resolve(jsonResponse({ data: updated }));
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
const bodyOf = (call: Parameters<typeof fetch> | undefined) =>
  JSON.parse(call?.[1]?.body as string) as Record<string, unknown>;

function renderRules() {
  return renderWithShell(<WorkflowRulesView workflowId={WORKFLOW_ID} />);
}

async function openNewRule() {
  await userEvent.click(await screen.findByRole('button', { name: 'Nova regra' }));
  return screen.findByRole('region', { name: 'Nova regra' });
}

async function chooseProcess(form: HTMLElement) {
  await userEvent.type(within(form).getByLabelText('Processo de referência'), '0012');
  await userEvent.click(await within(form).findByRole('button', { name: '0012/2026 — Notebooks' }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SCR-035 · regras de etapa e de transição (US-044)', () => {
  it('[Sucesso] cria regra REQUIRED_DOCUMENT na saída de ESTUDOS_PRELIMINARES; sem violações de a11y', async () => {
    const state = initialState();
    const api = mockApi(state);
    renderRules();

    expect(await screen.findByText('Nenhuma regra configurada para esta etapa.')).toBeTruthy();
    const form = await openNewRule();
    await waitFor(() => {
      expect(within(form).getByRole('button', { name: 'Criar regra' })).toHaveProperty(
        'disabled',
        false,
      );
    });
    // Só tipos de documento ativos.
    expect(within(form).queryByRole('option', { name: 'ANTIGO — Tipo antigo' })).toBeNull();
    await userEvent.selectOptions(
      within(form).getByLabelText('Tipo de documento'),
      'ETP — Estudo técnico preliminar',
    );
    await userEvent.type(within(form).getByLabelText('Nome'), 'ETP completo');
    await userEvent.type(
      within(form).getByLabelText('Mensagem ao usuário'),
      'O ETP deve estar completo.',
    );
    expect(await seriousA11yViolations()).toEqual([]);
    await userEvent.click(within(form).getByRole('button', { name: 'Criar regra' }));

    expect(await screen.findByText('O ETP deve estar completo.')).toBeTruthy();
    expect(bodyOf(calls(api, 'POST', '/rules')[0])).toEqual({
      scope: 'STAGE_EXIT',
      stageId: ESTUDOS_ID,
      transitionId: null,
      type: 'REQUIRED_DOCUMENT',
      name: 'ETP completo',
      severity: 'BLOCKING',
      config: { documentTypeCode: 'ETP', minStatus: 'COMPLETE' },
      message: 'O ETP deve estar completo.',
      isActive: true,
      displayOrder: 0,
    });
    expect(screen.getByRole('button', { name: /Estudos preliminares.*1 regra/ })).toBeTruthy();
  });

  it('FA-03: "Testar regra" antes de salvar avalia a config do formulário e anuncia o resultado', async () => {
    const api = mockApi(initialState());
    renderRules();
    const form = await openNewRule();
    await userEvent.selectOptions(
      within(form).getByLabelText('Tipo de documento'),
      'ETP — Estudo técnico preliminar',
    );
    await userEvent.type(
      within(form).getByLabelText('Mensagem ao usuário'),
      'O ETP deve estar completo.',
    );
    await chooseProcess(form);
    await userEvent.click(within(form).getByRole('button', { name: 'Testar regra' }));

    expect(
      await within(form).findByText('Não satisfeita — O ETP deve estar completo.'),
    ).toBeTruthy();
    expect(within(form).getByText('matchingCount')).toBeTruthy();
    expect(bodyOf(calls(api, 'POST', '/rules/test')[0])).toEqual({
      type: 'REQUIRED_DOCUMENT',
      config: { documentTypeCode: 'ETP', minStatus: 'COMPLETE' },
      severity: 'BLOCKING',
      message: 'O ETP deve estar completo.',
      processId: PROCESS_ID,
    });
    // Nada foi salvo.
    expect(calls(api, 'POST', `/workflow-versions/${DRAFT_ID}/rules`).length).toBe(1);
  });

  it('FA-04: aviso "Campo não reconhecido" junto ao resultado do teste', async () => {
    mockApi(initialState(), {
      testResult: {
        satisfied: false,
        severity: 'BLOCKING',
        message: 'Preencha o código.',
        contextUsed: {},
        warnings: [{ code: 'PATH_UNKNOWN', message: 'Campo não reconhecido.' }],
      },
    });
    renderRules();
    const form = await openNewRule();
    await userEvent.selectOptions(within(form).getByLabelText('Tipo'), 'Campo obrigatório');
    await userEvent.type(within(form).getByLabelText('Campo obrigatório'), 'process.codigo');
    await chooseProcess(form);
    await userEvent.click(within(form).getByRole('button', { name: 'Testar regra' }));
    expect(await within(form).findByText('Atenção: Campo não reconhecido.')).toBeTruthy();
    expect(within(form).getByText('Nenhum valor do processo foi lido.')).toBeTruthy();
  });

  it('CONDITION: construtor gera JSON Logic; operador proibido no teste → mensagem; modo JSON', async () => {
    const api = mockApi(initialState(), {
      override: (url, method, body) =>
        method === 'POST' && url.endsWith('/rules/test') && JSON.stringify(body).includes('method')
          ? problem(422, 'WORKFLOW_INVALID')
          : null,
    });
    renderRules();
    const form = await openNewRule();
    await userEvent.selectOptions(within(form).getByLabelText('Tipo'), 'Condição');
    await userEvent.click(await within(form).findByRole('button', { name: 'Adicionar condição' }));
    await userEvent.selectOptions(
      within(form).getByLabelText('Operador da condição 1'),
      'é maior que',
    );
    await userEvent.type(within(form).getByLabelText('Valor da condição 1'), '100000');
    await chooseProcess(form);
    await userEvent.click(within(form).getByRole('button', { name: 'Testar regra' }));
    await waitFor(() => {
      expect(calls(api, 'POST', '/rules/test')).toHaveLength(1);
    });
    expect(bodyOf(calls(api, 'POST', '/rules/test')[0]).config).toEqual({
      expression: { and: [{ '>': [{ var: 'process.estimatedValue' }, 100000] }] },
    });

    await userEvent.click(within(form).getByRole('button', { name: 'Editar como JSON' }));
    const json = within(form).getByLabelText('Expressão JSON Logic');
    fireEvent.change(json, {
      target: { value: '{"method":[{"var":"process.modalityCode"},"x"]}' },
    });
    await userEvent.click(within(form).getByRole('button', { name: 'Testar regra' }));
    expect(
      await within(form).findByText('Esta condição usa um operador não permitido.'),
    ).toBeTruthy();
  });

  it('[Validação] campos obrigatórios marcados no front, sem chamar a API', async () => {
    const api = mockApi(initialState());
    renderRules();
    const form = await openNewRule();
    await waitFor(() => {
      expect(within(form).getByRole('button', { name: 'Criar regra' })).toHaveProperty(
        'disabled',
        false,
      );
    });
    await userEvent.click(within(form).getByRole('button', { name: 'Criar regra' }));
    expect(await within(form).findByText('Informe o nome.')).toBeTruthy();
    expect(within(form).getByText('Informe a mensagem ao usuário.')).toBeTruthy();
    expect(within(form).getByText('Selecione o tipo de documento.')).toBeTruthy();
    expect(calls(api, 'POST', '/rules')).toHaveLength(0);
  });

  it('[Permissão] só WORKFLOW_VIEW: lista visível, sem "Nova regra", editar, excluir nem reordenar', async () => {
    mockApi(initialState([ruleOf({})]), { permissions: ['WORKFLOW_VIEW'] });
    renderRules();
    expect(await screen.findByText('O ETP deve estar completo.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Nova regra' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Editar a regra ETP completo' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reordenar/ })).toBeNull();
  });

  it('[Concorrência] PATCH com If-Match divergente → aviso para recarregar', async () => {
    const state = initialState([ruleOf({ version: 3 })]);
    mockApi(state, {
      override: (url, method) =>
        method === 'PATCH' && url.includes('/workflow-rules/')
          ? problem(412, 'VERSION_CONFLICT')
          : null,
    });
    renderRules();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Editar a regra ETP completo' }),
    );
    const form = await screen.findByRole('region', { name: 'Editar regra ETP completo' });
    await waitFor(() => {
      expect(within(form).getByRole('button', { name: 'Salvar regra' })).toHaveProperty(
        'disabled',
        false,
      );
    });
    await userEvent.selectOptions(within(form).getByLabelText('Severidade'), 'Aviso');
    await userEvent.click(within(form).getByRole('button', { name: 'Salvar regra' }));
    expect(
      await screen.findByText('Os dados foram alterados. Recarregue e tente novamente.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Recarregar' })).toBeTruthy();
  });

  it('FA-05: versão publicada no meio da edição → "Esta versão não pode mais ser editada." com o atalho', async () => {
    mockApi(initialState(), {
      override: (url, method) =>
        method === 'POST' && url.endsWith(`/workflow-versions/${DRAFT_ID}/rules`)
          ? problem(409, 'WORKFLOW_VERSION_NOT_DRAFT')
          : null,
    });
    renderRules();
    const form = await openNewRule();
    await userEvent.selectOptions(within(form).getByLabelText('Tipo'), 'Aprovação obrigatória');
    await userEvent.selectOptions(
      within(form).getByLabelText('Etapa de aprovação'),
      'Aprovação da autoridade',
    );
    await userEvent.type(within(form).getByLabelText('Nome'), 'Aprovação da autoridade');
    await userEvent.type(
      within(form).getByLabelText('Mensagem ao usuário'),
      'Aguarde a aprovação.',
    );
    await waitFor(() => {
      expect(within(form).getByRole('button', { name: 'Criar regra' })).toHaveProperty(
        'disabled',
        false,
      );
    });
    await userEvent.click(within(form).getByRole('button', { name: 'Criar regra' }));
    expect(await screen.findByText('Esta versão não pode mais ser editada.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Criar novo rascunho' }).getAttribute('href')).toBe(
      `/admin/workflows/${WORKFLOW_ID}`,
    );
  });

  it('FA-01: seta ↓ no ícone de reordenar envia um PATCH de displayOrder por regra alterada', async () => {
    const first = ruleOf({ name: 'Primeira', displayOrder: 0 });
    const second = ruleOf({ name: 'Segunda', displayOrder: 1, message: 'Segunda mensagem.' });
    const api = mockApi(initialState([first, second]));
    renderRules();
    const handle = await screen.findByRole('button', {
      name: 'Reordenar Primeira (posição 1). Use as setas para cima e para baixo.',
    });
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    await waitFor(() => {
      expect(calls(api, 'PATCH', '/workflow-rules/')).toHaveLength(2);
    });
    expect(calls(api, 'PATCH', '/workflow-rules/').map((call) => bodyOf(call))).toEqual([
      { displayOrder: 0 },
      { displayOrder: 1 },
    ]);
    expect(await screen.findByText('Primeira movida para a posição 2.')).toBeTruthy();
  });

  it('exclui a regra com o If-Match e desativa sem excluir (FA-02)', async () => {
    const state = initialState([ruleOf({ version: 2 })]);
    const api = mockApi(state);
    renderRules();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Editar a regra ETP completo' }),
    );
    const form = await screen.findByRole('region', { name: 'Editar regra ETP completo' });
    await userEvent.click(within(form).getByLabelText('Regra ativa'));
    await waitFor(() => {
      expect(within(form).getByRole('button', { name: 'Salvar regra' })).toHaveProperty(
        'disabled',
        false,
      );
    });
    await userEvent.click(within(form).getByRole('button', { name: 'Salvar regra' }));
    expect(await screen.findByText('Inativa')).toBeTruthy();
    expect(bodyOf(calls(api, 'PATCH', '/workflow-rules/')[0])).toEqual({ isActive: false });

    await userEvent.click(screen.getByRole('button', { name: 'Excluir a regra ETP completo' }));
    expect(await screen.findByText('Nenhuma regra configurada para esta etapa.')).toBeTruthy();
    expect(
      new Headers(calls(api, 'DELETE', '/workflow-rules/')[0]?.[1]?.headers).get('If-Match'),
    ).toBe('"3"');
  });

  it('[Falha de integração] WF-19 indisponível: aviso e "Salvar" desabilitado até o schema carregar', async () => {
    let schemaDown = true;
    mockApi(initialState(), {
      override: (url) =>
        url.startsWith('/api/v1/rule-context/schema') && schemaDown
          ? problem(503, 'DEPENDENCY_UNAVAILABLE')
          : null,
    });
    renderRules();
    const form = await openNewRule();
    expect(
      await within(form).findByText(
        'Não foi possível carregar os campos disponíveis. Tente novamente.',
      ),
    ).toBeTruthy();
    expect(within(form).getByRole('button', { name: 'Criar regra' })).toHaveProperty(
      'disabled',
      true,
    );
    schemaDown = false;
    await userEvent.click(within(form).getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => {
      expect(within(form).getByRole('button', { name: 'Criar regra' })).toHaveProperty(
        'disabled',
        false,
      );
    });
  });
});
