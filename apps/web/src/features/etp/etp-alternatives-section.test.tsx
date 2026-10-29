// @vitest-environment jsdom
import type { EtpAlternativeDto, EtpAlternativeListMeta } from '@contrataflow/validation';
import { cleanup, configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api/api-error';
import { seriousA11yViolations } from '@test/support/axe';
import { chooseOption } from '@test/support/kit';
import { ID, bodyOf, mockProcessApi, problemResponse } from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import {
  alternativeFormValuesOf,
  alternativePatchOf,
  alternativeProblemOf,
  createAlternativeBodyOf,
  movedOrder,
  validateAlternative,
} from './etp-alternatives-model';
import { EtpAlternativesSection } from './etp-alternatives-section';

configure({ asyncUtilTimeout: 8_000 });
vi.setConfig({ testTimeout: 30_000 });

/*
 * US-021 — seção "Alternativas" da SCR-008 com a API simulada (ETP-05..09): quadro comparativo
 * (ordem, recomendada, custo mascarado — POL-09), cadastro pelo `AlternativeFormDrawer` (V-01/V-02/
 * V-07 com o schema da API), decisão com justificativa (V-04), substituição da recomendada (FA-01),
 * exclusão (FA-03), reordenação, modo somente leitura (Permissão · FA-05) e axe.
 */

const ETP_ID = ID(900);
const AT = '2026-10-18T17:31:00.000Z';
const JUSTIFICATION = 'A locação reduz o custo total do período.';

const doc = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

function alternative(n: number, extra: Partial<EtpAlternativeDto> = {}): EtpAlternativeDto {
  return {
    id: ID(910 + n),
    etpId: ETP_ID,
    processId: ID(1),
    name: `Alternativa ${String(n)}`,
    description: doc(`Descrição da alternativa ${String(n)}.`),
    advantages: null,
    disadvantages: null,
    estimatedCost: null,
    estimatedCostMasked: false,
    riskLevel: null,
    observations: null,
    sortOrder: n,
    decision: 'UNDER_ANALYSIS',
    decisionJustification: null,
    createdAt: AT,
    updatedAt: AT,
    version: 1,
    ...extra,
  };
}

interface ApiState {
  alternatives: EtpAlternativeDto[];
  meta: EtpAlternativeListMeta;
  decide?: (call: number, init?: RequestInit) => Response;
  /** Quantas leituras do ETP-05 respondem 503 antes de voltar. */
  listFailures?: number;
}

function mockApi(initial: Partial<ApiState> = {}) {
  const state: ApiState = {
    alternatives: initial.alternatives ?? [],
    meta: initial.meta ?? {
      canManage: true,
      recommendedAlternativeId: null,
      estimatedCostMasked: false,
    },
    ...(initial.decide ? { decide: initial.decide } : {}),
    listFailures: initial.listFailures ?? 0,
  };
  const base = mockProcessApi({ permissions: ['PROCESS_VIEW'] });
  let decideCalls = 0;
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url === `/api/v1/etps/${ETP_ID}/alternatives`) {
      if ((state.listFailures ?? 0) > 0) {
        state.listFailures = (state.listFailures ?? 0) - 1;
        return Promise.resolve(problemResponse(503, 'DEPENDENCY_UNAVAILABLE'));
      }
      return Promise.resolve(
        jsonResponse({
          data: [...state.alternatives].sort((a, b) => a.sortOrder - b.sortOrder),
          meta: state.meta,
        }),
      );
    }
    if (method === 'POST' && url === `/api/v1/etps/${ETP_ID}/alternatives`) {
      const body = bodyOf(init) as Partial<EtpAlternativeDto>;
      const created = alternative(state.alternatives.length + 1, {
        ...body,
        sortOrder: state.alternatives.length,
      });
      state.alternatives.push(created);
      return Promise.resolve(jsonResponse({ data: created }, { status: 201 }));
    }
    const patch = /^\/api\/v1\/etp-alternatives\/([0-9a-f-]{36})$/.exec(url);
    if (patch && method === 'PATCH') {
      const current = state.alternatives.find((row) => row.id === patch[1]);
      if (current === undefined) return Promise.resolve(problemResponse(404, 'NOT_FOUND'));
      const next = {
        ...current,
        ...(bodyOf(init) as Partial<EtpAlternativeDto>),
        version: current.version + 1,
      };
      state.alternatives = state.alternatives.map((row) => (row.id === next.id ? next : row));
      return Promise.resolve(jsonResponse({ data: next }));
    }
    if (patch && method === 'DELETE') {
      state.alternatives = state.alternatives.filter((row) => row.id !== patch[1]);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    const decide = /^\/api\/v1\/etp-alternatives\/([0-9a-f-]{36})\/decide$/.exec(url);
    if (decide && method === 'POST') {
      decideCalls += 1;
      const custom = state.decide?.(decideCalls, init);
      if (custom) return Promise.resolve(custom);
      const body = bodyOf(init) as { decision: EtpAlternativeDto['decision'] };
      const current = state.alternatives.find((row) => row.id === decide[1]);
      if (current === undefined) return Promise.resolve(problemResponse(404, 'NOT_FOUND'));
      const next = { ...current, decision: body.decision, version: current.version + 1 };
      state.alternatives = state.alternatives.map((row) => (row.id === next.id ? next : row));
      return Promise.resolve(jsonResponse({ data: next }));
    }
    return base(input, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, state };
}

const callsOf = (
  fetchMock: ReturnType<typeof mockApi>['fetchMock'],
  method: string,
  part: string,
) =>
  fetchMock.mock.calls.filter(
    ([input, init]) => (init?.method ?? 'GET') === method && requestUrl(input).includes(part),
  );
const ifMatchOf = (init: RequestInit | undefined) => new Headers(init?.headers).get('If-Match');
const table = () =>
  screen.getByRole('table', { name: 'Quadro comparativo das alternativas de solução' });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('EtpAlternativesSection (US-021 · SCR-008)', () => {
  it('[Sucesso] vazio → "Nova alternativa" → cadastra com custo e risco; o quadro passa a mostrar a linha', async () => {
    const user = userEvent.setup();
    const { fetchMock } = mockApi();
    renderWithShell(<EtpAlternativesSection etpId={ETP_ID} />);
    expect(await screen.findByText('Nenhuma alternativa cadastrada ainda.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Nova alternativa' }));
    const drawer = await screen.findByRole('dialog', { name: 'Nova alternativa' });
    await user.type(within(drawer).getByLabelText('Nome'), 'Locação de equipamentos');
    await user.type(within(drawer).getByLabelText('Descrição'), 'Locação mensal com manutenção.');
    await user.type(within(drawer).getByLabelText('Custo estimado'), '15000');
    await chooseOption(user, 'Nível de risco', 'Baixo', drawer);
    await user.click(within(drawer).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => {
      expect(callsOf(fetchMock, 'POST', '/alternatives')).toHaveLength(1);
    });
    const [, init] = callsOf(fetchMock, 'POST', '/alternatives')[0] ?? [];
    expect(bodyOf(init)).toEqual({
      name: 'Locação de equipamentos',
      description: doc('Locação mensal com manutenção.'),
      // O `MoneyInput` normaliza ao sair do campo ("15.000,00").
      estimatedCost: '15000.00',
      riskLevel: 'LOW',
    });
    const row = await within(table()).findByRole('rowheader', { name: 'Locação de equipamentos' });
    expect(row).toBeTruthy();
    expect(within(table()).getByText('Baixo')).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('[Validação] V-01/V-02 no front com as mensagens da story, sem chamar a API', async () => {
    const user = userEvent.setup();
    const { fetchMock } = mockApi();
    renderWithShell(<EtpAlternativesSection etpId={ETP_ID} />);
    await user.click(await screen.findByRole('button', { name: 'Nova alternativa' }));
    const drawer = await screen.findByRole('dialog', { name: 'Nova alternativa' });
    await user.click(within(drawer).getByRole('button', { name: 'Salvar' }));
    expect(
      await within(drawer).findByText('Informe um nome de até 150 caracteres para a alternativa.'),
    ).toBeTruthy();
    expect(within(drawer).getByText('Descreva a alternativa.')).toBeTruthy();
    expect(callsOf(fetchMock, 'POST', '/alternatives')).toEqual([]);
  });

  it('[Validação] decidir sem justificativa mostra a mensagem e não envia; com justificativa envia If-Match', async () => {
    const user = userEvent.setup();
    const { fetchMock } = mockApi({ alternatives: [alternative(1, { name: 'Aquisição direta' })] });
    renderWithShell(<EtpAlternativesSection etpId={ETP_ID} />);
    await user.click(
      await within(await screen.findByRole('table')).findByRole('button', {
        name: 'Ações de Aquisição direta',
      }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Descartar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Descartar alternativa' });
    await user.click(within(dialog).getByRole('button', { name: 'Descartar' }));
    expect(
      await within(dialog).findByText('Justifique a decisão (mín. 20 caracteres).'),
    ).toBeTruthy();
    expect(callsOf(fetchMock, 'POST', '/decide')).toEqual([]);

    await user.type(
      within(dialog).getByLabelText('Justificativa (mín. 20 caracteres)'),
      'Custo de manutenção alto demais.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Descartar' }));
    await waitFor(() => {
      expect(callsOf(fetchMock, 'POST', '/decide')).toHaveLength(1);
    });
    const [, init] = callsOf(fetchMock, 'POST', '/decide')[0] ?? [];
    expect(ifMatchOf(init)).toBe('"1"');
    expect(bodyOf(init)).toEqual({
      decision: 'DISCARDED',
      decisionJustification: 'Custo de manutenção alto demais.',
    });
  });

  it('FA-01: com outra recomendada, o 409 vira "Substituir recomendação", que reenvia com replaceRecommended', async () => {
    const user = userEvent.setup();
    const recommended = alternative(1, {
      name: 'Locação de equipamentos',
      decision: 'RECOMMENDED',
      decisionJustification: JUSTIFICATION,
    });
    const { fetchMock } = mockApi({
      alternatives: [recommended, alternative(2, { name: 'Aquisição direta' })],
      meta: {
        canManage: true,
        recommendedAlternativeId: recommended.id,
        estimatedCostMasked: false,
      },
      decide: (call) =>
        call === 1
          ? problemResponse(409, 'RECOMMENDED_ALTERNATIVE_EXISTS', {
              detail: 'Já existe uma alternativa recomendada. Substituir pela atual?',
              extension: { meta: { recommendedAlternativeId: recommended.id } },
            })
          : jsonResponse({
              data: alternative(2, {
                name: 'Aquisição direta',
                decision: 'RECOMMENDED',
                version: 2,
              }),
            }),
    });
    renderWithShell(<EtpAlternativesSection etpId={ETP_ID} />);
    const recommendedRow = await within(await screen.findByRole('table')).findByRole('row', {
      name: /Locação de equipamentos/,
    });
    expect(recommendedRow.getAttribute('aria-current')).toBe('true');

    await user.click(within(table()).getByRole('button', { name: 'Ações de Aquisição direta' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Recomendar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Recomendar alternativa' });
    await user.type(
      within(dialog).getByLabelText('Justificativa (mín. 20 caracteres)'),
      'Melhor custo-benefício levantado.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Recomendar' }));
    const replace = await screen.findByRole('dialog', {
      name: 'Substituir a alternativa recomendada?',
    });
    expect(within(replace).getByText(/Recomendada atual: Locação de equipamentos/)).toBeTruthy();
    await user.click(within(replace).getByRole('button', { name: 'Substituir recomendação' }));
    await waitFor(() => {
      expect(callsOf(fetchMock, 'POST', '/decide')).toHaveLength(2);
    });
    expect(bodyOf(callsOf(fetchMock, 'POST', '/decide')[1]?.[1])).toEqual({
      decision: 'RECOMMENDED',
      decisionJustification: 'Melhor custo-benefício levantado.',
      replaceRecommended: true,
    });
  });

  it('FA-03: excluir a recomendada pede a mudança da decisão; a não recomendada é excluída com If-Match', async () => {
    const user = userEvent.setup();
    const recommended = alternative(1, {
      name: 'Locação',
      decision: 'RECOMMENDED',
      decisionJustification: JUSTIFICATION,
    });
    const { fetchMock } = mockApi({
      alternatives: [recommended, alternative(2, { name: 'Comodato', version: 3 })],
      meta: {
        canManage: true,
        recommendedAlternativeId: recommended.id,
        estimatedCostMasked: false,
      },
    });
    renderWithShell(<EtpAlternativesSection etpId={ETP_ID} />);
    await user.click(
      await within(await screen.findByRole('table')).findByRole('button', {
        name: 'Ações de Locação',
      }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Excluir' }));
    const blocked = await screen.findByRole('dialog', { name: 'Excluir alternativa' });
    expect(
      within(blocked).getByText('Altere a decisão desta alternativa antes de excluí-la.'),
    ).toBeTruthy();
    expect(within(blocked).queryByRole('button', { name: 'Excluir' })).toBeNull();
    await user.click(within(blocked).getByRole('button', { name: 'Cancelar' }));

    await user.click(within(table()).getByRole('button', { name: 'Ações de Comodato' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Excluir' }));
    const dialog = await screen.findByRole('dialog', { name: 'Excluir alternativa' });
    await user.click(within(dialog).getByRole('button', { name: 'Excluir' }));
    await waitFor(() => {
      expect(callsOf(fetchMock, 'DELETE', '/etp-alternatives/')).toHaveLength(1);
    });
    expect(ifMatchOf(callsOf(fetchMock, 'DELETE', '/etp-alternatives/')[0]?.[1])).toBe('"3"');
    await waitFor(() => {
      expect(within(table()).queryByRole('rowheader', { name: 'Comodato' })).toBeNull();
    });
  });

  it('Reordenar: "Mover para cima" grava o sortOrder das duas linhas com as versões delas', async () => {
    const user = userEvent.setup();
    const { fetchMock } = mockApi({
      alternatives: [
        alternative(0, { name: 'Primeira', version: 2 }),
        alternative(1, { name: 'Segunda', version: 5 }),
      ],
    });
    renderWithShell(<EtpAlternativesSection etpId={ETP_ID} />);
    await user.click(
      await within(await screen.findByRole('table')).findByRole('button', {
        name: 'Ações de Primeira',
      }),
    );
    const up = await screen.findByRole('menuitem', { name: 'Mover para cima' });
    expect(up.getAttribute('aria-disabled')).toBe('true');
    await user.keyboard('{Escape}');
    await user.click(within(table()).getByRole('button', { name: 'Ações de Segunda' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Mover para cima' }));
    await waitFor(() => {
      expect(callsOf(fetchMock, 'PATCH', '/etp-alternatives/')).toHaveLength(2);
    });
    const patches = callsOf(fetchMock, 'PATCH', '/etp-alternatives/').map(([input, init]) => ({
      url: requestUrl(input),
      body: bodyOf(init),
      ifMatch: ifMatchOf(init),
    }));
    expect(patches).toEqual([
      { url: `/api/v1/etp-alternatives/${ID(911)}`, body: { sortOrder: 0 }, ifMatch: '"5"' },
      { url: `/api/v1/etp-alternatives/${ID(910)}`, body: { sortOrder: 1 }, ifMatch: '"2"' },
    ]);
    await waitFor(() => {
      expect(
        within(table())
          .getAllByRole('rowheader')
          .map((cell) => cell.textContent),
      ).toEqual(['Segunda', 'Primeira']);
    });
  });

  it('[Permissão] sem canManage: somente leitura, sem controles; FA-04: custo mascarado como "Sigiloso"', async () => {
    mockApi({
      alternatives: [
        alternative(1, { name: 'Locação', estimatedCost: null, estimatedCostMasked: true }),
      ],
      meta: { canManage: false, recommendedAlternativeId: null, estimatedCostMasked: true },
    });
    renderWithShell(<EtpAlternativesSection etpId={ETP_ID} />);
    expect(
      await screen.findByText(
        'Somente leitura: você não pode editar as alternativas deste ETP agora.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Nova alternativa' })).toBeNull();
    expect(within(table()).queryAllByRole('button')).toEqual([]);
    expect(within(table()).getByText('Sigiloso')).toBeTruthy();
    expect(
      screen.getByText('Orçamento sigiloso: os custos estimados não são exibidos para você.'),
    ).toBeTruthy();
  });

  it('[Falha de banco] 503 no carregamento: erro com "Tentar novamente"', async () => {
    const user = userEvent.setup();
    // A política de consultas repete 503 algumas vezes antes de mostrar o erro.
    const { state } = mockApi({ listFailures: 100 });
    renderWithShell(<EtpAlternativesSection etpId={ETP_ID} />);
    expect(await screen.findByText('Não foi possível carregar as alternativas.')).toBeTruthy();
    state.listFailures = 0;
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('Nenhuma alternativa cadastrada ainda.')).toBeTruthy();
  });
});

describe('etp-alternatives-model', () => {
  it('formulário ↔ corpo: textos viram rich text; custo em reais vira decimal; mascarado fica de fora', () => {
    const values = {
      ...alternativeFormValuesOf(null),
      name: '  Locação  ',
      description: 'Linha 1\nLinha 2',
      advantages: 'Sem investimento',
      estimatedCost: '15.000,50',
      riskLevel: 'HIGH' as const,
    };
    expect(createAlternativeBodyOf(values)).toEqual({
      name: 'Locação',
      description: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Linha 1' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Linha 2' }] },
        ],
      },
      advantages: doc('Sem investimento'),
      estimatedCost: '15000.50',
      riskLevel: 'HIGH',
    });
    expect(createAlternativeBodyOf(values, { masked: true })).not.toHaveProperty('estimatedCost');
    expect(validateAlternative({ ...values, estimatedCost: '10,555' })).toEqual({
      estimatedCost: 'Informe um valor válido, com até 2 casas decimais.',
    });
  });

  it('patch só com o que mudou; custo mascarado nunca vai no patch', () => {
    const current = alternative(1, { estimatedCost: '100.00', riskLevel: 'LOW' });
    const values = alternativeFormValuesOf(current);
    expect(values.estimatedCost).toBe('100,00');
    expect(alternativePatchOf(current, values)).toEqual({});
    expect(alternativePatchOf(current, { ...values, estimatedCost: '', riskLevel: '' })).toEqual({
      estimatedCost: null,
      riskLevel: null,
    });
    const masked = alternative(1, { estimatedCostMasked: true });
    expect(
      alternativePatchOf(masked, { ...alternativeFormValuesOf(masked), estimatedCost: '1,00' }),
    ).toEqual({});
  });

  it('movedOrder troca as posições e só devolve quem mudou; nos extremos não faz nada', () => {
    const rows = [
      { id: 'a', sortOrder: 0 },
      { id: 'b', sortOrder: 1 },
      { id: 'c', sortOrder: 2 },
    ];
    expect(movedOrder(rows, 'c', -1)).toEqual([
      { id: 'c', sortOrder: 1 },
      { id: 'b', sortOrder: 2 },
    ]);
    expect(movedOrder(rows, 'a', -1)).toEqual([]);
    expect(movedOrder(rows, 'c', 1)).toEqual([]);
  });

  it('alternativeProblemOf: 409, 412, 403, 422 de justificativa e de campos', () => {
    const error = (status: number, code: string, extra: Record<string, unknown> = {}) =>
      new ApiError({ status, code, detail: code, ...extra });
    expect(alternativeProblemOf(error(412, 'VERSION_CONFLICT')).kind).toBe('stale');
    expect(alternativeProblemOf(error(409, 'RECOMMENDED_ALTERNATIVE_EXISTS')).kind).toBe(
      'recommendedExists',
    );
    expect(alternativeProblemOf(error(409, 'DOCUMENT_NOT_EDITABLE'))).toEqual({
      kind: 'blocked',
      message: 'Este ETP não pode ser editado no status atual.',
    });
    expect(alternativeProblemOf(error(403, 'PERMISSION_DENIED'))).toEqual({
      kind: 'permission',
      message: 'Você não pode editar as alternativas deste ETP.',
    });
    expect(
      alternativeProblemOf(
        error(422, 'VALIDATION_ERROR', {
          errors: [{ field: 'decisionJustification', code: 'TOO_SHORT', message: 'x' }],
        }),
      ).kind,
    ).toBe('justification');
    expect(
      alternativeProblemOf(
        error(422, 'VALIDATION_ERROR', {
          errors: [{ field: 'name', code: 'DUPLICATE_IN_LIST', message: 'Já existe…' }],
        }),
      ),
    ).toEqual({ kind: 'fields', fields: { name: 'Já existe…' } });
    expect(alternativeProblemOf(error(503, 'DEPENDENCY_UNAVAILABLE')).kind).toBe('unavailable');
    expect(alternativeProblemOf(error(404, 'NOT_FOUND')).kind).toBe('notFound');
    expect(alternativeProblemOf(new Error('x')).kind).toBe('unexpected');
  });
});
