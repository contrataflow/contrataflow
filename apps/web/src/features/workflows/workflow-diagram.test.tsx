// @vitest-environment jsdom
import type {
  WorkflowDto,
  WorkflowStageDto,
  WorkflowTransitionDto,
  WorkflowVersionDetailDto,
  WorkflowVersionSummaryDto,
} from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { WorkflowEditorView } from './workflow-editor';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/workflows/x',
}));

/*
 * US-046 — aba "Diagrama" do SCR-034: somente leitura (RN-WF-70), nós e arestas da versão de WF-09
 * (RN-WF-72), troca de versão por WF-07 (RN-WF-73), aviso de etapa inalcançável (RN-WF-74), lista
 * alternativa quando o layout falha (FA-04 · RN-WF-75), minimapa acima de 20 etapas (FA-02), aviso
 * de versão aposentada (FA-03), estados vazio/erro e a aba oculta sem WORKFLOW_VIEW.
 */

const WORKFLOW_ID = '0192a000-0000-7000-8000-000000000046';
const V1 = '0192a000-0000-7000-8000-0000000004f1';
const V2 = '0192a000-0000-7000-8000-0000000004f2';
const VIEW = ['WORKFLOW_VIEW'];

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('fixture ausente');
  return value;
}

const uuid = (prefix: string, index: number) =>
  `0192a000-0000-7000-8000-${prefix}${String(index).padStart(12 - prefix.length, '0')}`;

function stage(
  versionId: string,
  index: number,
  key: string,
  name: string,
  type: WorkflowStageDto['type'],
  extra: Partial<WorkflowStageDto> = {},
): WorkflowStageDto {
  return {
    id: uuid(versionId === V1 ? 'a1' : 'a2', index),
    workflowVersionId: versionId,
    key,
    name,
    instructions: null,
    type,
    groupLabel: null,
    displayOrder: index,
    departmentResolution: 'REQUESTING_DEPARTMENT',
    fixedDepartmentId: null,
    assignmentPolicy: 'UNASSIGNED',
    approverType: type === 'APPROVAL' ? 'ROLE' : null,
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
    ...extra,
  };
}

function transition(
  stages: readonly WorkflowStageDto[],
  index: number,
  from: string,
  to: string,
  name: string,
  action: WorkflowTransitionDto['action'] = 'FORWARD',
  isPrimary = true,
): WorkflowTransitionDto {
  const id = (key: string) => stages.find((item) => item.key === key)?.id ?? uuid('ff', 999);
  return {
    id: uuid('b0', index),
    workflowVersionId: stages[0]?.workflowVersionId ?? V2,
    key: `${from}_${to}`,
    name,
    description: null,
    fromStageId: id(from),
    toStageId: id(to),
    action,
    displayOrder: index,
    isPrimary,
    requiresComment: action === 'RETURN',
    allowDueDateOverride: false,
  };
}

/** "Fase preparatória — Lei 14.133/2021": 7 etapas publicadas. */
function preparatoryStages(versionId: string): WorkflowStageDto[] {
  return [
    stage(versionId, 0, 'ABERTURA', 'Abertura', 'START'),
    stage(versionId, 1, 'DFD', 'Formalização da demanda', 'TASK', {
      color: '#2563eb',
      slaDays: 5,
    }),
    stage(versionId, 2, 'ETP', 'Estudo técnico preliminar', 'TASK', { groupLabel: 'Planejamento' }),
    stage(versionId, 3, 'PESQUISA', 'Pesquisa de preços', 'TASK'),
    stage(versionId, 4, 'TR', 'Termo de referência', 'TASK'),
    stage(versionId, 5, 'APROVACAO', 'Aprovação da autoridade', 'APPROVAL'),
    stage(versionId, 6, 'CONCLUSAO', 'Conclusão', 'END'),
  ];
}

function preparatoryTransitions(stages: readonly WorkflowStageDto[]): WorkflowTransitionDto[] {
  return [
    transition(stages, 1, 'ABERTURA', 'DFD', 'Iniciar a demanda'),
    transition(stages, 2, 'DFD', 'ETP', 'Encaminhar ao ETP'),
    transition(stages, 3, 'ETP', 'PESQUISA', 'Encaminhar à pesquisa'),
    transition(stages, 4, 'PESQUISA', 'TR', 'Encaminhar ao TR'),
    transition(stages, 5, 'TR', 'APROVACAO', 'Enviar para aprovação'),
    transition(stages, 6, 'APROVACAO', 'CONCLUSAO', 'Aprovar', 'APPROVE'),
    transition(stages, 7, 'APROVACAO', 'TR', 'Indeferir', 'REJECT', false),
    transition(stages, 8, 'ETP', 'DFD', 'Devolver ao DFD', 'RETURN', false),
  ];
}

function summary(
  id: string,
  versionNumber: number,
  status: WorkflowVersionSummaryDto['status'],
): WorkflowVersionSummaryDto {
  return {
    id,
    workflowId: WORKFLOW_ID,
    versionNumber,
    status,
    changeNotes: null,
    publishedAt: '2026-10-01T13:00:00.000Z',
    publishedById: null,
    publishedByName: null,
    retiredAt: status === 'RETIRED' ? '2026-10-10T13:00:00.000Z' : null,
    retiredById: null,
    retiredByName: null,
    definitionHash: 'a'.repeat(64),
    createdAt: '2026-10-01T12:00:00.000Z',
    createdById: null,
    version: 2,
  };
}

function versionOf(
  item: WorkflowVersionSummaryDto,
  stages: WorkflowStageDto[],
  transitions: WorkflowTransitionDto[],
): WorkflowVersionDetailDto {
  return { ...item, initialStageId: stages[0]?.id ?? null, stages, transitions, rules: [] };
}

interface State {
  workflow: WorkflowDto;
  history: WorkflowVersionSummaryDto[];
  versions: Map<string, WorkflowVersionDetailDto>;
}

function initialState(): State {
  const v2Stages = preparatoryStages(V2);
  // A v1 aposentada não tinha o termo de referência.
  const v1Stages = preparatoryStages(V1).filter((item) => item.key !== 'TR');
  const v1Transitions = [
    transition(v1Stages, 11, 'ABERTURA', 'DFD', 'Iniciar a demanda'),
    transition(v1Stages, 12, 'DFD', 'ETP', 'Encaminhar ao ETP'),
    transition(v1Stages, 13, 'ETP', 'PESQUISA', 'Encaminhar à pesquisa'),
    transition(v1Stages, 14, 'PESQUISA', 'APROVACAO', 'Enviar para aprovação'),
    transition(v1Stages, 15, 'APROVACAO', 'CONCLUSAO', 'Aprovar', 'APPROVE'),
  ];
  const v2 = summary(V2, 2, 'PUBLISHED');
  const v1 = summary(V1, 1, 'RETIRED');
  return {
    workflow: {
      id: WORKFLOW_ID,
      key: 'DEFAULT_PREPARATORY',
      name: 'Fase preparatória — Lei 14.133/2021',
      description: null,
      isActive: true,
      isDefault: true,
      applicabilityRule: null,
      applicabilityPriority: 100,
      currentPublishedVersion: { id: V2, versionNumber: 2, publishedAt: null },
      draftVersion: null,
      version: 1,
    },
    history: [v2, v1],
    versions: new Map([
      [V2, versionOf(v2, v2Stages, preparatoryTransitions(v2Stages))],
      [V1, versionOf(v1, v1Stages, v1Transitions)],
    ]),
  };
}

function problem(status: number, code: string): Response {
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
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

function mockApi(
  state: State,
  options: { permissions?: readonly string[]; version?: (id: string) => Response | null } = {},
) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/v1/me/permissions')) {
      return Promise.resolve(
        jsonResponse({
          data: {
            permissions: (options.permissions ?? VIEW).map((code) => ({ code, scopes: [] })),
          },
        }),
      );
    }
    if (url.startsWith('/api/v1/document-types'))
      return Promise.resolve(jsonResponse({ data: [] }));
    if (method === 'GET' && url === `/api/v1/workflows/${WORKFLOW_ID}`) {
      return Promise.resolve(jsonResponse({ data: state.workflow }));
    }
    if (method === 'GET' && url.startsWith(`/api/v1/workflows/${WORKFLOW_ID}/versions`)) {
      return Promise.resolve(jsonResponse({ data: state.history }));
    }
    const match = /^\/api\/v1\/workflow-versions\/([^/?]+)$/.exec(url);
    if (method === 'GET' && match?.[1]) {
      const override = options.version?.(match[1]);
      if (override) return Promise.resolve(override);
      const found = state.versions.get(match[1]);
      if (found) return Promise.resolve(jsonResponse({ data: found }));
    }
    return Promise.resolve(problem(404, 'NOT_FOUND'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const versionCalls = (fetchMock: ReturnType<typeof mockApi>, id: string) =>
  fetchMock.mock.calls.filter(([input]) => requestUrl(input) === `/api/v1/workflow-versions/${id}`);

async function openDiagramTab() {
  renderWithShell(<WorkflowEditorView workflowId={WORKFLOW_ID} />);
  await userEvent.click(await screen.findByRole('tab', { name: 'Diagrama' }));
  return screen.findByRole('tabpanel', { name: 'Diagrama' });
}

/** Troca a versão exibida pelo seletor do kit (Radix Select). */
async function chooseVersion(panel: HTMLElement, option: string) {
  await userEvent.click(within(panel).getByRole('combobox', { name: 'Versão exibida' }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

const stageNodes = (panel: HTMLElement) =>
  within(within(panel).getByRole('list', { name: 'Etapas do diagrama' })).getAllByRole('button');
const edgeLabels = (panel: HTMLElement) =>
  within(within(panel).getByRole('list', { name: 'Transições do diagrama' })).getAllByRole(
    'button',
  );

// `workflow.diagram_viewed` sai no console a cada desenho (lib/client-log): fora da saída do teste.
beforeEach(() => {
  vi.spyOn(globalThis.console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Aba "Diagrama" do editor de workflow (US-046)', () => {
  it('[Sucesso] exibe 7 nós e as transições; CONCLUSAO é END; detalhes só leitura ao clicar', async () => {
    mockApi(initialState());
    const panel = await openDiagramTab();

    await within(panel).findByRole('list', { name: 'Etapas do diagrama' });
    const nodes = stageNodes(panel);
    expect(nodes).toHaveLength(7);
    expect(edgeLabels(panel)).toHaveLength(8);
    const end = within(panel).getByRole('button', { name: /^Etapa Conclusão, tipo Fim/ });
    expect(end.dataset.stageType).toBe('END');
    // RN-WF-72: SLA, grupo e indicador distinto da aprovação.
    expect(
      within(panel).getByRole('button', {
        name: 'Etapa Formalização da demanda, tipo Tarefa. SLA 5 dias úteis',
      }),
    ).toBeTruthy();
    expect(
      within(panel).getByRole('button', {
        name: 'Etapa Estudo técnico preliminar, tipo Tarefa. Grupo Planejamento',
      }),
    ).toBeTruthy();
    expect(
      within(panel)
        .getByRole('button', { name: /^Etapa Aprovação da autoridade, tipo Aprovação/ })
        .getAttribute('data-stage-type'),
    ).toBe('APPROVAL');
    expect(
      within(panel).getByRole('button', {
        name: 'Transição Aprovar: Aprovação da autoridade → Conclusão. Aprovar. Ação principal',
      }),
    ).toBeTruthy();

    await userEvent.click(end);
    const details = within(panel).getByRole('complementary', { name: 'Etapa Conclusão' });
    expect(within(details).getByText('CONCLUSAO')).toBeTruthy();
    expect(within(details).getByText(/Somente leitura/)).toBeTruthy();
    // RN-WF-70: nenhuma ação de criar, editar ou excluir a partir do diagrama.
    expect(
      within(panel).queryAllByRole('button', { name: /Adicionar|Excluir|Salvar|Editar/ }),
    ).toHaveLength(0);
    expect(within(panel).queryAllByRole('textbox')).toHaveLength(0);

    await userEvent.click(
      within(panel).getByRole('button', { name: /^Transição Devolver ao DFD/ }),
    );
    const edgeDetails = within(panel).getByRole('complementary', {
      name: 'Transição Devolver ao DFD',
    });
    expect(
      within(edgeDetails).getByText('Estudo técnico preliminar → Formalização da demanda'),
    ).toBeTruthy();
    expect(within(edgeDetails).getByText('Devolver')).toBeTruthy();

    expect(await seriousA11yViolations(document.body)).toEqual([]);
  });

  it('[Validação] versão sem etapas: estado vazio "Nenhuma etapa criada ainda"', async () => {
    const state = initialState();
    const v2 = must(state.versions.get(V2));
    state.versions.set(V2, { ...v2, stages: [], transitions: [] });
    mockApi(state);
    const panel = await openDiagramTab();

    expect(await within(panel).findByText('Nenhuma etapa criada ainda')).toBeTruthy();
    expect(within(panel).queryByRole('list', { name: 'Etapas do diagrama' })).toBeNull();
  });

  it('[Permissão] sem WORKFLOW_VIEW a aba "Diagrama" não é exibida', async () => {
    mockApi(initialState(), { permissions: [] });
    renderWithShell(<WorkflowEditorView workflowId={WORKFLOW_ID} />);

    expect(await screen.findByRole('tab', { name: 'Etapas' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Diagrama' })).toBeNull();
  });

  it('[Duplicidade] selecionar a mesma versão não duplica nós; trocar recalcula e avisa aposentada', async () => {
    const fetchMock = mockApi(initialState());
    const panel = await openDiagramTab();
    await within(panel).findByRole('list', { name: 'Etapas do diagrama' });
    await within(panel).findByRole('combobox', { name: 'Versão exibida' });
    expect(stageNodes(panel)).toHaveLength(7);
    const readsBefore = versionCalls(fetchMock, V2).length;

    await chooseVersion(panel, 'Versão 2 — Publicada');
    expect(stageNodes(panel)).toHaveLength(7);
    expect(versionCalls(fetchMock, V2)).toHaveLength(readsBefore);

    // FA-03 · RN-WF-73: a versão aposentada também é desenhada, com o aviso no topo.
    await chooseVersion(panel, 'Versão 1 — Aposentada');
    expect(await within(panel).findByText('Esta versão está aposentada')).toBeTruthy();
    await waitFor(() => {
      expect(stageNodes(panel)).toHaveLength(6);
    });
    expect(within(panel).queryByRole('button', { name: /Termo de referência/ })).toBeNull();

    await chooseVersion(panel, 'Versão 2 — Publicada');
    await waitFor(() => {
      expect(stageNodes(panel)).toHaveLength(7);
    });
    expect(within(panel).queryByText('Esta versão está aposentada')).toBeNull();
  });

  it('[Falha de banco] 503 só na versão escolhida no seletor: mensagem e nova tentativa', async () => {
    let unavailable = true;
    mockApi(initialState(), {
      version: (id) => (id === V1 && unavailable ? problem(503, 'DEPENDENCY_UNAVAILABLE') : null),
    });
    const panel = await openDiagramTab();
    await within(panel).findByRole('list', { name: 'Etapas do diagrama' });
    await within(panel).findByRole('combobox', { name: 'Versão exibida' });
    await chooseVersion(panel, 'Versão 1 — Aposentada');

    expect(
      await within(panel).findByText(
        'Não foi possível carregar o diagrama agora. Tente novamente.',
        {},
        { timeout: 15_000 },
      ),
    ).toBeTruthy();
    unavailable = false;
    await userEvent.click(within(panel).getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => {
      expect(stageNodes(panel)).toHaveLength(6);
    });
  });

  it('[Tenant incorreto] versão de outro tenant (404): "Workflow não encontrado."', async () => {
    mockApi(initialState(), { version: (id) => (id === V1 ? problem(404, 'NOT_FOUND') : null) });
    const panel = await openDiagramTab();
    await within(panel).findByRole('list', { name: 'Etapas do diagrama' });
    await within(panel).findByRole('combobox', { name: 'Versão exibida' });
    await chooseVersion(panel, 'Versão 1 — Aposentada');

    expect(await within(panel).findByText('Workflow não encontrado.')).toBeTruthy();
    expect(
      within(panel).getByRole('link', { name: 'Voltar para a lista de workflows' }),
    ).toBeTruthy();
  });

  it('[Falha de integração] layout impossível: lista simples, aviso e log no console sem travar', async () => {
    const warn = vi.spyOn(globalThis.console, 'warn').mockImplementation(() => undefined);
    const state = initialState();
    const v2 = must(state.versions.get(V2));
    const orphan = { ...must(v2.transitions[0]), id: uuid('b0', 99), toStageId: uuid('ff', 1) };
    state.versions.set(V2, { ...v2, transitions: [...v2.transitions, orphan] });
    mockApi(state);
    const panel = await openDiagramTab();

    expect(
      await within(panel).findByText('Não foi possível desenhar o diagrama; veja a lista abaixo.'),
    ).toBeTruthy();
    const list = within(panel).getByRole('region', { name: 'Etapas' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(7);
    expect(within(panel).getByRole('region', { name: 'Transições' })).toBeTruthy();
    expect(within(panel).queryByRole('list', { name: 'Etapas do diagrama' })).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        event: 'workflow.diagram_layout_failed',
        workflowVersionId: V2,
        reason: 'UNKNOWN_STAGE',
      }),
    );
    // A tela continua respondendo: as outras abas abrem normalmente.
    await userEvent.click(screen.getByRole('tab', { name: 'Etapas' }));
    expect(await screen.findByRole('tabpanel', { name: 'Etapas' })).toBeTruthy();
  });

  it('RN-WF-74: etapa inalcançável fica destacada com aviso, sem impedir o desenho', async () => {
    const state = initialState();
    const v2 = must(state.versions.get(V2));
    const island = stage(V2, 7, 'ILHA', 'Etapa solta', 'TASK');
    state.versions.set(V2, { ...v2, status: 'DRAFT', stages: [...v2.stages, island] });
    mockApi(state);
    const panel = await openDiagramTab();

    await within(panel).findByRole('list', { name: 'Etapas do diagrama' });
    expect(stageNodes(panel)).toHaveLength(8);
    expect(
      within(panel).getByRole('button', {
        name: 'Etapa Etapa solta, tipo Tarefa. Aviso: não pode ser alcançada a partir da etapa inicial nem leva ao fim do fluxo',
      }),
    ).toBeTruthy();
  });

  it('FA-02: acima de 20 etapas abre com minimapa; zoom e ajustar à tela pelos botões', async () => {
    const info = vi.spyOn(globalThis.console, 'info').mockImplementation(() => undefined);
    const state = initialState();
    const v2 = must(state.versions.get(V2));
    const stages = Array.from({ length: 24 }, (_, index) =>
      stage(
        V2,
        index,
        `E${String(index)}`,
        `Etapa ${String(index + 1)}`,
        index === 0 ? 'START' : index === 23 ? 'END' : 'TASK',
      ),
    );
    const transitions = stages
      .slice(1)
      .map((item, index) =>
        transition(
          stages,
          index + 1,
          `E${String(index)}`,
          item.key,
          `Avançar ${String(index + 1)}`,
        ),
      );
    state.versions.set(V2, { ...v2, stages, transitions });
    mockApi(state);
    const panel = await openDiagramTab();

    await within(panel).findByRole('list', { name: 'Etapas do diagrama' });
    expect(stageNodes(panel)).toHaveLength(24);
    expect(within(panel).getByRole('button', { name: /^Minimapa:/ })).toBeTruthy();
    const minimapToggle = within(panel).getByRole('button', { name: 'Minimapa' });
    expect(minimapToggle.getAttribute('aria-pressed')).toBe('true');
    // Ajustado ao quadro (960 px) logo ao abrir: menos de 100%.
    const level = within(panel).getByText(/^Zoom \d+%$/);
    expect(Number(/\d+/.exec(level.textContent)?.[0])).toBeLessThan(100);
    await userEvent.click(within(panel).getByRole('button', { name: 'Aproximar' }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Ajustar à tela' }));
    await userEvent.click(minimapToggle);
    expect(within(panel).queryByRole('button', { name: /^Minimapa:/ })).toBeNull();
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'workflow.diagram_viewed',
        workflowVersionId: V2,
        nodes: 24,
        edges: 23,
      }),
    );
    expect(await seriousA11yViolations(document.body)).toEqual([]);
  });
});
