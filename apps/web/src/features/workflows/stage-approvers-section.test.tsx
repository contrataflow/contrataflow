// @vitest-environment jsdom
import type { WorkflowStageDto } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { StageApproversSection } from './stage-approvers-section';

/*
 * US-132 — "Quem decide" no painel da etapa (SCR-034): política e lista ordenada salvas juntas pelo
 * WF-65 (If-Match da etapa), reordenação por botões e teclado com anúncio, regras locais antes da
 * API (V-04/V-05), erro da API na linha, conflito (412) para a tela e modo leitura com o resumo.
 */

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

const STAGE_ID = '0192a000-0000-7000-8000-000000000132';
const MARCOS = '0192a000-0000-7000-8000-0000000000a1';
const ROBERTO = '0192a000-0000-7000-8000-0000000000a2';

const stage: WorkflowStageDto = {
  id: STAGE_ID,
  workflowVersionId: '0192a000-0000-7000-8000-0000000000d1',
  key: 'AUTORIZACAO_LICITACAO',
  name: 'Autorização da licitação',
  instructions: null,
  type: 'APPROVAL',
  groupLabel: null,
  displayOrder: 2,
  departmentResolution: 'REQUESTING_DEPARTMENT',
  fixedDepartmentId: null,
  assignmentPolicy: 'UNASSIGNED',
  approverType: 'DEPARTMENT_HEAD',
  approverUserId: null,
  approverRoleId: null,
  approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
  approverFixedDepartmentId: null,
  allowDeputy: true,
  approvalDocumentTypeCodes: [],
  documentTypeCodes: [],
  slaDays: 5,
  slaType: 'BUSINESS',
  color: null,
  decisionPolicy: 'ANY',
  approvers: [],
  branchKey: null,
  version: 3,
};

function problem(status: number, code: string, errors: object[] = []): Response {
  return new Response(
    JSON.stringify({
      type: `https://docs.contrataflow.com.br/errors/${code.toLowerCase()}`,
      title: code,
      status,
      detail: code,
      instance: '/api/v1/x',
      code,
      correlationId: 'c-test',
      errors,
      violations: [],
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

function mockApi(onPut: (body: Record<string, unknown>, ifMatch: string | null) => Response) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    if (url.startsWith('/api/v1/me/permissions')) {
      return Promise.resolve(jsonResponse({ data: { permissions: [] } }));
    }
    if (url.startsWith('/api/v1/users')) {
      return Promise.resolve(
        jsonResponse({
          data: [
            { userId: MARCOS, name: 'Marcos Procurador', socialName: null },
            { userId: ROBERTO, name: 'Roberto Secretário', socialName: null },
          ],
        }),
      );
    }
    if (url.endsWith(`/workflow-stages/${STAGE_ID}/approvers`) && init?.method === 'PUT') {
      return Promise.resolve(
        onPut(
          JSON.parse(init.body as string) as Record<string, unknown>,
          new Headers(init.headers).get('If-Match'),
        ),
      );
    }
    return Promise.resolve(problem(404, 'NOT_FOUND'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function choose(scope: HTMLElement, field: string, option: string) {
  await userEvent.click(within(scope).getByRole('combobox', { name: field }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

const lineOf = (position: number, total: number) =>
  screen.getByRole('listitem', { name: `Aprovador ${String(position)} de ${String(total)}` });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SCR-034 · Quem decide (US-132)', () => {
  it('[Sucesso] SEQUENTIAL com usuário e titular, reordenação por teclado e salvar pelo WF-65', async () => {
    const saved: WorkflowStageDto[] = [];
    const puts: { body: Record<string, unknown>; ifMatch: string | null }[] = [];
    mockApi((body, ifMatch) => {
      puts.push({ body, ifMatch });
      const approvers = (body.approvers as Record<string, unknown>[]).map((line, index) => ({
        id: `0192a000-0000-7000-8000-00000000010${String(index)}`,
        sequence: index + 1,
        approverUserId: null,
        approverRoleId: null,
        approverDepartmentResolution: null,
        approverFixedDepartmentId: null,
        allowDeputy: true,
        label: null,
        ...line,
        resolved: { label: 'x', status: 'OK' },
      }));
      return jsonResponse({
        data: { stageId: STAGE_ID, decisionPolicy: body.decisionPolicy, approvers, version: 4 },
      });
    });
    renderWithShell(
      <StageApproversSection
        stage={stage}
        readOnly={false}
        onSaved={(next) => saved.push(next)}
        onProblem={vi.fn()}
      />,
    );
    const section = screen.getByRole('region', { name: 'Quem decide' });
    expect(
      within(section).getByText('Nenhum aprovador definido — a etapa usa o aprovador único.'),
    ).toBeTruthy();

    await choose(section, 'Política de decisão', 'Aprovam em sequência');
    await userEvent.click(within(section).getByRole('button', { name: 'Adicionar aprovador' }));
    await userEvent.click(within(section).getByRole('button', { name: 'Adicionar aprovador' }));
    // Linha 1: usuário Marcos com rótulo; linha 2 fica titular da secretaria solicitante.
    await choose(lineOf(1, 2), 'Tipo de aprovador', 'Usuário específico');
    await choose(lineOf(1, 2), 'Usuário', 'Marcos Procurador');
    await userEvent.type(
      within(lineOf(1, 2)).getByLabelText('Rótulo (opcional)'),
      'Procurador-Geral',
    );

    // Teclado: seta para baixo no botão de ordem move a linha 1 para a posição 2, com anúncio.
    within(lineOf(1, 2)).getByRole('button', { name: 'Descer o aprovador 1' }).focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(await screen.findByText('Procurador-Geral movido para a posição 2.')).toBeTruthy();

    await userEvent.click(within(section).getByRole('button', { name: 'Salvar aprovadores' }));
    await waitFor(() => {
      expect(puts).toHaveLength(1);
    });
    expect(puts[0]).toEqual({
      ifMatch: '"3"',
      body: {
        decisionPolicy: 'SEQUENTIAL',
        approvers: [
          {
            approverType: 'DEPARTMENT_HEAD',
            approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
            allowDeputy: true,
          },
          {
            approverType: 'USER',
            approverUserId: MARCOS,
            allowDeputy: true,
            label: 'Procurador-Geral',
          },
        ],
      },
    });
    expect(await within(section).findByText('Aprovadores salvos')).toBeTruthy();
    // A etapa do cache: política, linhas, ETag e o espelho da linha 1 (RN-APV-08).
    expect(saved.at(-1)).toMatchObject({
      decisionPolicy: 'SEQUENTIAL',
      version: 4,
      approverType: 'DEPARTMENT_HEAD',
      approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
    });
    expect(saved.at(-1)?.approvers.map((line) => line.sequence)).toEqual([1, 2]);
    expect(within(section).getByTestId('approver-summary').textContent).toBe(
      'Aprovam em sequência: 1. Titular da secretaria solicitante → 2. Procurador-Geral',
    );
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('[Validação] aprovador repetido e linha sem referência são barrados sem chamar a API', async () => {
    const fetchMock = mockApi(() => jsonResponse({}));
    renderWithShell(
      <StageApproversSection
        stage={stage}
        readOnly={false}
        onSaved={vi.fn()}
        onProblem={vi.fn()}
      />,
    );
    const section = screen.getByRole('region', { name: 'Quem decide' });
    await choose(section, 'Política de decisão', 'Todos aprovam');
    await userEvent.click(within(section).getByRole('button', { name: 'Adicionar aprovador' }));
    await userEvent.click(within(section).getByRole('button', { name: 'Adicionar aprovador' }));
    await userEvent.click(within(section).getByRole('button', { name: 'Adicionar aprovador' }));
    await choose(lineOf(3, 3), 'Tipo de aprovador', 'Usuário específico');
    await userEvent.click(within(section).getByRole('button', { name: 'Salvar aprovadores' }));
    expect(
      await within(lineOf(2, 3)).findByText('O mesmo aprovador não pode aparecer duas vezes.'),
    ).toBeTruthy();
    expect(within(lineOf(3, 3)).getByText('Informe o aprovador da linha 3.')).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
  });

  it('[Tenant incorreto] erro de referência da API aparece na linha; [Concorrência] 412 vai para a tela', async () => {
    let status = 422;
    mockApi(() =>
      status === 422
        ? problem(422, 'VALIDATION_ERROR', [
            {
              field: 'approvers[1].approverUserId',
              code: 'REFERENCE_NOT_FOUND',
              message: 'Selecione um valor válido.',
            },
          ])
        : problem(412, 'VERSION_CONFLICT'),
    );
    const onProblem = vi.fn();
    renderWithShell(
      <StageApproversSection
        stage={stage}
        readOnly={false}
        onSaved={vi.fn()}
        onProblem={onProblem}
      />,
    );
    const section = screen.getByRole('region', { name: 'Quem decide' });
    await choose(section, 'Política de decisão', 'Todos aprovam');
    await userEvent.click(within(section).getByRole('button', { name: 'Adicionar aprovador' }));
    await userEvent.click(within(section).getByRole('button', { name: 'Adicionar aprovador' }));
    await choose(lineOf(2, 2), 'Tipo de aprovador', 'Usuário específico');
    await choose(lineOf(2, 2), 'Usuário', 'Roberto Secretário');
    await userEvent.click(within(section).getByRole('button', { name: 'Salvar aprovadores' }));
    expect(await within(lineOf(2, 2)).findByText('Selecione um valor válido.')).toBeTruthy();

    status = 412;
    await userEvent.click(within(section).getByRole('button', { name: 'Salvar aprovadores' }));
    await waitFor(() => {
      expect(onProblem).toHaveBeenCalledWith({ kind: 'conflict' });
    });
  });

  it('[Permissão] em leitura mostra só o resumo da política e da ordem', () => {
    mockApi(() => jsonResponse({}));
    renderWithShell(
      <StageApproversSection
        stage={{
          ...stage,
          decisionPolicy: 'ALL',
          approvers: [
            {
              id: '0192a000-0000-7000-8000-000000000201',
              sequence: 1,
              approverType: 'DEPARTMENT_HEAD',
              approverUserId: null,
              approverRoleId: null,
              approverDepartmentResolution: 'REQUESTING_DEPARTMENT',
              approverFixedDepartmentId: null,
              allowDeputy: true,
              label: 'Chefe do setor',
            },
            {
              id: '0192a000-0000-7000-8000-000000000202',
              sequence: 2,
              approverType: 'DEPARTMENT_HEAD',
              approverUserId: null,
              approverRoleId: null,
              approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
              approverFixedDepartmentId: null,
              allowDeputy: true,
              label: null,
            },
          ],
        }}
        readOnly
        onSaved={vi.fn()}
        onProblem={vi.fn()}
      />,
    );
    expect(screen.getByTestId('approver-summary').textContent).toBe(
      'Todos aprovam: 1. Chefe do setor; 2. Titular da secretaria solicitante',
    );
    expect(screen.queryByRole('button', { name: 'Salvar aprovadores' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Política de decisão' })).toBeNull();
  });
});
