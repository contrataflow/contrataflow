// @vitest-environment jsdom
import { Toaster } from '@contrataflow/ui';
import type {
  WorkflowDto,
  WorkflowValidationIssue,
  WorkflowValidationResult,
  WorkflowVersionDetailDto,
  WorkflowVersionSummaryDto,
} from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { WorkflowEditorView } from './workflow-editor';
import { changeNotesProblem, issueTarget, retireBlocked } from './workflow-versions-model';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
  usePathname: () => '/admin/workflows/x',
}));

/*
 * US-045 — aba "Versões" do SCR-034: histórico (WF-07), "Validar" (WF-20) com a lista de problemas
 * e o link para corrigir, "Publicar" (WF-21) desabilitado com erros e com as notas da versão
 * obrigatórias a partir da v2, "Aposentar" (WF-22) e a visibilidade por permissão.
 */

const WORKFLOW_ID = '0192a000-0000-7000-8000-000000000045';
const V1 = '0192a000-0000-7000-8000-0000000000f1';
const V2 = '0192a000-0000-7000-8000-0000000000f2';
const PUBLISH = ['WORKFLOW_VIEW', 'WORKFLOW_MANAGE', 'WORKFLOW_PUBLISH'];

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
    changeNotes: status === 'DRAFT' ? null : 'Versão inicial.',
    publishedAt: status === 'DRAFT' ? null : '2026-10-01T13:00:00.000Z',
    publishedById: null,
    publishedByName: status === 'DRAFT' ? null : 'Carla Mendes',
    retiredAt: null,
    retiredById: null,
    retiredByName: null,
    definitionHash: status === 'DRAFT' ? null : 'a'.repeat(64),
    createdAt: '2026-10-01T12:00:00.000Z',
    createdById: null,
    version: 3,
  };
}

function detail(item: WorkflowVersionSummaryDto): WorkflowVersionDetailDto {
  return { ...item, initialStageId: null, stages: [], transitions: [], rules: [] };
}

interface State {
  workflow: WorkflowDto;
  history: WorkflowVersionSummaryDto[];
}

function initialState(): State {
  return {
    workflow: {
      id: WORKFLOW_ID,
      key: 'FASE_PREPARATORIA',
      name: 'Fase preparatória — Lei 14.133/2021',
      description: null,
      isActive: true,
      isDefault: false,
      applicabilityRule: null,
      applicabilityPriority: 100,
      currentPublishedVersion: { id: V1, versionNumber: 1, publishedAt: null },
      draftVersion: { id: V2, versionNumber: 2 },
      version: 1,
    },
    history: [summary(V2, 2, 'DRAFT'), summary(V1, 1, 'PUBLISHED')],
  };
}

function problem(status: number, code: string, extra: object = {}): Response {
  return new Response(
    JSON.stringify({
      type: `https://docs.contrataflow.com.br/errors/${code.toLowerCase()}`,
      title: code,
      status,
      detail:
        code === 'WORKFLOW_IN_USE' ? 'Publique uma nova versão antes de aposentar esta.' : code,
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

const issue = (
  code: WorkflowValidationIssue['code'],
  message: string,
  stageKey: string | null = null,
): WorkflowValidationIssue => ({
  code,
  message,
  stageKey,
  transitionKey: null,
  ruleId: null,
});

function mockApi(
  state: State,
  options: {
    permissions?: readonly string[];
    validation?: WorkflowValidationResult;
    publish?: () => Response;
    retire?: () => Response;
  } = {},
) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/v1/me/permissions')) {
      return Promise.resolve(
        jsonResponse({
          data: {
            permissions: (options.permissions ?? PUBLISH).map((code) => ({ code, scopes: [] })),
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
    const version = /^\/api\/v1\/workflow-versions\/([^/]+)(\/\w+)?$/.exec(url);
    const found = state.history.find((item) => item.id === version?.[1]);
    if (method === 'GET' && version && !version[2] && found) {
      return Promise.resolve(jsonResponse({ data: detail(found) }));
    }
    if (method === 'POST' && version?.[2] === '/validate') {
      return Promise.resolve(
        jsonResponse({ data: options.validation ?? { valid: true, errors: [], warnings: [] } }),
      );
    }
    if (method === 'POST' && version?.[2] === '/publish' && found) {
      if (options.publish) return Promise.resolve(options.publish());
      const published = {
        ...found,
        status: 'PUBLISHED' as const,
        version: found.version + 1,
        changeNotes: 'Inclui a análise de riscos.',
      };
      state.history = state.history.map((item) =>
        item.id === found.id
          ? published
          : item.status === 'PUBLISHED'
            ? { ...item, status: 'RETIRED' }
            : item,
      );
      state.workflow = {
        ...state.workflow,
        currentPublishedVersion: { id: found.id, versionNumber: 2, publishedAt: null },
        draftVersion: null,
      };
      return Promise.resolve(jsonResponse({ data: published }));
    }
    if (method === 'POST' && version?.[2] === '/retire' && found) {
      if (options.retire) return Promise.resolve(options.retire());
      return Promise.resolve(jsonResponse({ data: { ...found, status: 'RETIRED' } }));
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

async function openVersionsTab() {
  renderWithShell(
    <>
      <WorkflowEditorView workflowId={WORKFLOW_ID} />
      <Toaster />
    </>,
  );
  await userEvent.click(await screen.findByRole('tab', { name: 'Versões' }));
  return screen.findByRole('tabpanel', { name: 'Versões' });
}

afterEach(() => {
  vi.unstubAllGlobals();
  push.mockReset();
});

describe('Aba "Versões" do editor de workflow (US-045)', () => {
  it('lista o histórico; "Publicar" só habilita depois de validar sem erros', async () => {
    mockApi(initialState(), {
      validation: {
        valid: true,
        errors: [],
        warnings: [issue('WF_STAGE_NO_SLA', 'A etapa Análise não tem prazo.', 'ANALISE')],
      },
    });
    const panel = await openVersionsTab();

    expect(await within(panel).findAllByText('Versão 1')).not.toHaveLength(0);
    expect(within(panel).getAllByText('Corrente')).not.toHaveLength(0);
    expect(within(panel).getAllByText(/por Carla Mendes/)).not.toHaveLength(0);
    const publish = within(panel).getByRole('button', { name: 'Publicar' });
    expect(publish).toHaveProperty('disabled', true);
    expect(publish.getAttribute('title')).toBe('Valide a versão antes de publicar.');

    await userEvent.click(within(panel).getByRole('button', { name: 'Validar' }));
    expect(await within(panel).findByText(/A etapa Análise não tem prazo/)).toBeTruthy();
    expect(within(panel).getByText(/1 aviso/)).toBeTruthy();
    await waitFor(() => {
      expect(within(panel).getByRole('button', { name: 'Publicar' })).toHaveProperty(
        'disabled',
        false,
      );
    });
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('com errors[] o botão fica desabilitado, o foco vai ao primeiro problema e o link leva às etapas (FA-05)', async () => {
    mockApi(initialState(), {
      validation: {
        valid: false,
        errors: [issue('WF_START_STAGE_COUNT', 'O fluxo precisa de exatamente uma etapa inicial.')],
        warnings: [],
      },
    });
    const panel = await openVersionsTab();
    await userEvent.click(await within(panel).findByRole('button', { name: 'Validar' }));

    const item = await within(panel).findByText(/precisa de exatamente uma etapa inicial/);
    await waitFor(() => {
      expect(document.activeElement).toBe(item.closest('li'));
    });
    expect(within(panel).getByText('1 problema impede a publicação')).toBeTruthy();
    const publish = within(panel).getByRole('button', { name: 'Publicar' });
    expect(publish).toHaveProperty('disabled', true);
    expect(publish.getAttribute('title')).toBe('Corrija os problemas indicados antes de publicar.');

    await userEvent.click(within(panel).getByRole('button', { name: 'Ir para as etapas' }));
    expect(screen.getByRole('tab', { name: 'Etapas' }).getAttribute('aria-selected')).toBe('true');
  });

  it('publicar a v2 exige as notas (sem chamar a API) e envia If-Match; sucesso com toast', async () => {
    const state = initialState();
    const fetchMock = mockApi(state);
    const panel = await openVersionsTab();
    await userEvent.click(await within(panel).findByRole('button', { name: 'Validar' }));
    await userEvent.click(await within(panel).findByRole('button', { name: 'Publicar' }));

    const dialog = await screen.findByRole('dialog', { name: 'Publicar a versão 2' });
    const notes = within(dialog).getByLabelText('Notas da versão (obrigatório)');
    await waitFor(() => {
      expect(document.activeElement).toBe(notes);
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Publicar' }));
    expect(await within(dialog).findByText('Descreva o que mudou nesta versão.')).toBeTruthy();
    expect(calls(fetchMock, 'POST', '/publish')).toHaveLength(0);
    expect(await seriousA11yViolations()).toEqual([]);

    await userEvent.type(notes, 'Inclui a análise de riscos.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Publicar' }));
    expect(await screen.findByText('Versão 2 publicada')).toBeTruthy();
    const [, init] = calls(fetchMock, 'POST', '/publish')[0] ?? [];
    expect(new Headers(init?.headers).get('If-Match')).toBe('"3"');
    expect(JSON.parse(init?.body as string)).toEqual({
      changeNotes: 'Inclui a análise de riscos.',
    });
  });

  it('422 WORKFLOW_INVALID na publicação volta ao painel com os erros da API', async () => {
    mockApi(initialState(), {
      publish: () =>
        problem(422, 'WORKFLOW_INVALID', {
          validation: {
            errors: [issue('WF_END_UNREACHABLE', 'A etapa final não é alcançável.', 'FIM')],
            warnings: [],
          },
        }),
    });
    const panel = await openVersionsTab();
    await userEvent.click(await within(panel).findByRole('button', { name: 'Validar' }));
    await userEvent.click(await within(panel).findByRole('button', { name: 'Publicar' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Notas.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Publicar' }));

    expect(await within(panel).findByText(/A etapa final não é alcançável/)).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Publicar' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('a corrente única de workflow ativo não é aposentada (FA-03): botão desabilitado com a explicação', async () => {
    mockApi(initialState());
    const panel = await openVersionsTab();
    const [current] = await within(panel).findAllByRole('button', {
      name: 'Aposentar a versão 1',
    });
    expect(current).toHaveProperty('disabled', true);
    expect(current?.getAttribute('title')).toBe(
      'Publique uma nova versão antes de aposentar esta.',
    );
  });

  it('aposentar: confirmação no diálogo; WORKFLOW_IN_USE da API é explicado', async () => {
    const state = initialState();
    // Outra publicada assume no cliente; a API ainda recusa (estado mudou entre a leitura e o envio).
    state.history = [
      ...state.history,
      summary('0192a000-0000-7000-8000-0000000000f0', 0, 'PUBLISHED'),
    ];
    const fetchMock = mockApi(state, { retire: () => problem(409, 'WORKFLOW_IN_USE') });
    const panel = await openVersionsTab();

    const [current] = await within(panel).findAllByRole('button', {
      name: 'Aposentar a versão 1',
    });
    if (!current) throw new Error('botão "Aposentar" ausente');
    await userEvent.click(current);
    const dialog = await screen.findByRole('dialog', { name: 'Aposentar a versão 1' });
    expect(await seriousA11yViolations()).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Aposentar' }));
    expect(
      await within(dialog).findByText('Publique uma nova versão antes de aposentar esta.'),
    ).toBeTruthy();
    const [, init] = calls(fetchMock, 'POST', '/retire')[0] ?? [];
    expect(new Headers(init?.headers).get('If-Match')).toBe('"3"');
  });

  it('só WORKFLOW_MANAGE: publicar e aposentar visíveis e desabilitados', async () => {
    mockApi(initialState(), { permissions: ['WORKFLOW_VIEW', 'WORKFLOW_MANAGE'] });
    const panel = await openVersionsTab();
    const publish = await within(panel).findByRole('button', { name: 'Publicar' });
    expect(publish).toHaveProperty('disabled', true);
    expect(publish.getAttribute('title')).toBe('Você não tem permissão para publicar workflows.');
    expect(
      within(panel).getAllByRole('button', { name: 'Aposentar a versão 1' })[0],
    ).toHaveProperty('disabled', true);
  });

  it('só WORKFLOW_VIEW: valida, mas publicar e aposentar ficam ocultos', async () => {
    mockApi(initialState(), { permissions: ['WORKFLOW_VIEW'] });
    const panel = await openVersionsTab();
    expect(await within(panel).findByRole('button', { name: 'Validar' })).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: 'Publicar' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Aposentar a versão 1' })).toBeNull();
  });
});

describe('workflow-versions-model', () => {
  const workflow = {
    isActive: true,
    isDefault: false,
    currentPublishedVersion: { id: 'v1', versionNumber: 1, publishedAt: null },
  };

  it('retireBlocked segue o RN-WF-66', () => {
    const v1 = { id: 'v1', status: 'PUBLISHED' as const };
    const v0 = { id: 'v0', status: 'PUBLISHED' as const };
    expect(retireBlocked(workflow, v1, [v1])).toBe(true);
    expect(retireBlocked(workflow, v1, [v1, v0])).toBe(false);
    expect(retireBlocked(workflow, v0, [v1, v0])).toBe(false);
    expect(retireBlocked({ ...workflow, isActive: false }, v1, [v1])).toBe(false);
    expect(retireBlocked({ ...workflow, isActive: false, isDefault: true }, v1, [v1])).toBe(true);
    expect(retireBlocked(workflow, { id: 'v1', status: 'DRAFT' }, [v1])).toBe(false);
  });

  it('changeNotesProblem: opcional na v1, obrigatório a partir da v2 (RN-WF-63)', () => {
    expect(changeNotesProblem(1, '')).toBeNull();
    expect(changeNotesProblem(2, '  ')).toBe('Descreva o que mudou nesta versão.');
    expect(changeNotesProblem(2, 'Mudou.')).toBeNull();
  });

  it('issueTarget aponta regra, transição, etapa ou nada', () => {
    const base = issue('WF_STAGE_UNREACHABLE', 'x');
    expect(issueTarget({ ...base, ruleId: 'r1' })).toEqual({ kind: 'rule', id: 'r1' });
    expect(issueTarget({ ...base, transitionKey: 'T' })).toEqual({
      kind: 'transition',
      key: 'T',
    });
    expect(issueTarget({ ...base, stageKey: 'S' })).toEqual({ kind: 'stage', key: 'S' });
    expect(issueTarget({ ...base, code: 'WF_START_STAGE_COUNT' })).toEqual({
      kind: 'stage',
      key: '',
    });
    expect(issueTarget(base)).toEqual({ kind: 'none' });
  });
});
