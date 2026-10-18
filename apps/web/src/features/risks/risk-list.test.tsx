// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import type { RiskDto, RiskListMetaDto } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeQueryClient } from '@/lib/query/query-client';
import { seriousA11yViolations } from '@test/support/axe';
import {
  ID,
  PROCESS_ID,
  bodyOf,
  callsTo,
  catalogItem,
  mockProcessApi,
  problemResponse,
} from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell } from '@test/support/render';
import { treatmentFixture } from '@test/support/risk-fixtures';

import { RiskList } from './risk-list';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

const LIST = `/api/v1/processes/${PROCESS_ID}/risks`;
const CATEGORY = catalogItem(241, 'RISK_CATEGORY', 'MERCADO', 'Risco de mercado');
const SCALE = {
  max: 5,
  probabilityLabels: ['Muito baixa', 'Baixa', 'Média', 'Alta', 'Muito alta'],
  impactLabels: ['Insignificante', 'Baixo', 'Médio', 'Alto', 'Crítico'],
};
const THRESHOLDS = [
  { level: 'LOW', minScore: 1, maxScore: 4 },
  { level: 'MEDIUM', minScore: 5, maxScore: 9 },
  { level: 'HIGH', minScore: 10, maxScore: 16 },
  { level: 'EXTREME', minScore: 17, maxScore: 25 },
] as const;

const editableMeta: RiskListMetaDto = {
  scale: SCALE,
  levelThresholds: [...THRESHOLDS],
  riskMap: null,
  canManage: true,
  lockReason: null,
};

function risk(sequence: number, extra: Partial<RiskDto> = {}): RiskDto {
  return {
    id: ID(900 + sequence),
    processId: PROCESS_ID,
    code: `R0${String(sequence)}`,
    title: `Risco número ${String(sequence)}`,
    description: null,
    categoryId: CATEGORY.id,
    category: { id: CATEGORY.id, code: CATEGORY.code, label: CATEGORY.label },
    phase: 'PLANNING',
    cause: 'Fornecedor com pouca capacidade',
    consequence: 'Obra parada por semanas',
    probability: 4,
    impact: 4,
    score: 16,
    level: 'HIGH',
    scaleSnapshot: { scale: SCALE, levelThresholds: [...THRESHOLDS] },
    ownerId: null,
    owner: null,
    ownerDepartmentId: null,
    ownerDepartment: null,
    residualProbability: null,
    residualImpact: null,
    residualScore: null,
    residualLevel: null,
    status: 'OPEN',
    sortOrder: sequence,
    treatments: [],
    aiGenerationId: null,
    aiReviewedAt: null,
    aiReviewedBy: null,
    version: 3,
    ...extra,
  };
}

type Route = (url: string, init?: RequestInit) => Response | undefined;

const noRetryClient = () => {
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
  return client;
};

function renderList(
  risks: readonly RiskDto[],
  options: { meta?: Partial<RiskListMetaDto>; handler?: Route; participants?: Route } = {},
) {
  const api = mockProcessApi({
    permissions: ['PROCESS_VIEW'],
    catalogs: { RISK_CATEGORY: [CATEGORY] },
    risks: (url, init) => {
      const handled = options.handler?.(url, init);
      if (handled) return handled;
      return jsonResponse({ data: risks, meta: { ...editableMeta, ...options.meta } });
    },
    participants: (url, init) =>
      options.participants?.(url, init) ?? jsonResponse({ data: [], meta: {} }),
  });
  renderWithShell(
    <>
      <RiskList processId={PROCESS_ID} />
      <Toaster />
    </>,
    { queryClient: noRetryClient() },
  );
  return api;
}

async function fillRequired(dialog: HTMLElement, user: ReturnType<typeof userEvent.setup>) {
  await user.type(within(dialog).getByLabelText(/^Título/), 'Atraso na entrega');
  await user.selectOptions(await within(dialog).findByLabelText(/^Categoria/), CATEGORY.id);
  await user.type(within(dialog).getByLabelText(/^Causa/), 'Fornecedor com pouca capacidade');
  await user.type(within(dialog).getByLabelText(/^Consequência/), 'Obra parada por semanas');
}

describe('SCR-011 · lista de riscos (US-033)', () => {
  it('[Estado] vazio: orientação e botão "Novo risco"', async () => {
    renderList([]);
    expect(
      await screen.findByText('Nenhum risco registrado. Comece identificando o primeiro risco.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Novo risco' })).toBeTruthy();
  });

  it('[Estado] erro: "Tentar novamente" recarrega', async () => {
    const user = userEvent.setup();
    let fail = true;
    const api = renderList([risk(1)], {
      handler: () => (fail ? problemResponse(500, 'INTERNAL_ERROR') : undefined),
    });
    expect(await screen.findByText('Não foi possível carregar os riscos agora.')).toBeTruthy();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('Risco número 1')).toBeTruthy();
    expect(callsTo(api, 'GET', LIST).length).toBe(2);
  });

  it('lista com nível em texto, responsável ("Sem responsável" — FA-03) e detalhes', async () => {
    const user = userEvent.setup();
    renderList([
      risk(1),
      risk(2, {
        probability: 2,
        impact: 3,
        score: 6,
        level: 'MEDIUM',
        owner: { id: ID(1), name: 'Ana Souza' },
        ownerId: ID(1),
        residualProbability: 1,
        residualImpact: 2,
        residualScore: 2,
        residualLevel: 'LOW',
        scaleSnapshot: { scale: { ...SCALE, max: 3 }, levelThresholds: [...THRESHOLDS] },
      }),
    ]);
    expect(await screen.findByText('Risco número 1')).toBeTruthy();
    expect(screen.getByText('2 riscos')).toBeTruthy();
    expect(screen.getByText('Sem responsável')).toBeTruthy();
    expect(screen.getByText('Ana Souza')).toBeTruthy();
    expect(screen.getByText(/Alto/)).toBeTruthy();
    expect(screen.getAllByText(/Médio/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Baixo/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Ver detalhes R02' }));
    expect(
      screen.getByText(
        'Avaliado na escala 3×3. A escala do tenant mudou; reavalie o risco para aplicar a escala vigente.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Nenhuma ação de tratamento. Adicione a primeira ação.')).toBeTruthy();
  });

  it('[Permissão] sem permissão: nem "Novo risco" nem editar/excluir', async () => {
    renderList([risk(1)], { meta: { canManage: false, lockReason: 'PERMISSION_DENIED' } });
    expect(await screen.findByText('Risco número 1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Novo risco' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Editar/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Excluir/ })).toBeNull();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('[FA-04] bloqueado: aviso, link para o Mapa de Riscos e ações desabilitadas', async () => {
    renderList([risk(1)], {
      meta: {
        canManage: false,
        lockReason: 'DOCUMENT_NOT_EDITABLE',
        riskMap: { id: ID(777), code: 'MR 0001/2026', status: 'FINALIZED' },
      },
    });
    expect(
      await screen.findByText(
        'Os riscos estão bloqueados porque o Mapa de Riscos foi concluído. Reabra o documento para editar.',
      ),
    ).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Abrir o Mapa de Riscos MR 0001/2026' });
    expect(link.getAttribute('href')).toBe(`/processos/${PROCESS_ID}/documentos/${ID(777)}`);
    expect(screen.getByRole('button', { name: 'Novo risco' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Editar R01' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Excluir R01' }).hasAttribute('disabled')).toBe(true);
  });

  it('outro motivo de bloqueio: ações desabilitadas com a mensagem pertinente', async () => {
    renderList([risk(1)], { meta: { canManage: false, lockReason: 'INVALID_PROCESS_STATUS' } });
    expect(
      await screen.findByText('Este processo não permite alterações nos riscos agora.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Novo risco' }).hasAttribute('disabled')).toBe(true);
  });

  it('[Sucesso] criação: validação local, avaliação em tempo real e Idempotency-Key', async () => {
    const user = userEvent.setup();
    const created = risk(1, { title: 'Atraso na entrega' });
    const api = renderList([], {
      handler: (url, init) =>
        init?.method === 'POST' && url === LIST
          ? jsonResponse({ data: created }, { status: 201, headers: { ETag: '"1"' } })
          : undefined,
    });
    await user.click(await screen.findByRole('button', { name: 'Novo risco' }));
    const dialog = await screen.findByRole('dialog');

    // Sem preencher nada: erros por campo e nenhuma chamada.
    await user.click(within(dialog).getByRole('button', { name: 'Salvar risco' }));
    expect(await within(dialog).findByText('Informe o título.')).toBeTruthy();
    expect(within(dialog).getByText('Informe a causa.')).toBeTruthy();
    expect(within(dialog).getByText('Informe a probabilidade.')).toBeTruthy();
    expect(callsTo(api, 'POST', LIST)).toEqual([]);

    await fillRequired(dialog, user);
    expect(
      within(dialog).getByText(
        'Selecione a probabilidade e o impacto para ver o escore e o nível.',
      ),
    ).toBeTruthy();
    await user.click(
      within(dialog).getByRole('gridcell', {
        name: 'Probabilidade Alta (4), impacto Alto (4): escore 16, nível Alto',
      }),
    );
    expect(within(dialog).getByText('Escore 16')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Salvar risco' }));

    await waitFor(() => {
      expect(callsTo(api, 'POST', LIST)).toHaveLength(1);
    });
    const [call] = callsTo(api, 'POST', LIST);
    expect(call?.headers.get('Idempotency-Key')).toBeTruthy();
    expect(call?.headers.get('If-Match')).toBeNull();
    expect(call?.body).toEqual({
      title: 'Atraso na entrega',
      categoryId: CATEGORY.id,
      phase: 'PLANNING',
      cause: 'Fornecedor com pouca capacidade',
      consequence: 'Obra parada por semanas',
      probability: 4,
      impact: 4,
    });
    expect(await screen.findByText('Risco R01 registrado')).toBeTruthy();
  });

  it('[Falha de banco] 503 mantém os dados e "Tentar novamente" reaproveita a Idempotency-Key', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const api = renderList([], {
      handler: (url, init) => {
        if (init?.method !== 'POST' || url !== LIST) return undefined;
        attempts += 1;
        return attempts === 1
          ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE')
          : jsonResponse({ data: risk(1) }, { status: 201 });
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Novo risco' }));
    const dialog = await screen.findByRole('dialog');
    await fillRequired(dialog, user);
    await user.click(
      within(dialog).getByRole('gridcell', {
        name: /Probabilidade Alta \(4\), impacto Alto \(4\)/,
      }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Salvar risco' }));
    expect(
      await within(dialog).findByText(
        'Não foi possível salvar o risco agora. Tente novamente em instantes.',
      ),
    ).toBeTruthy();
    expect(within(dialog).getByLabelText<HTMLInputElement>(/^Título/).value).toBe(
      'Atraso na entrega',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => {
      expect(callsTo(api, 'POST', LIST)).toHaveLength(2);
    });
    const [first, second] = callsTo(api, 'POST', LIST);
    expect(second?.headers.get('Idempotency-Key')).toBe(first?.headers.get('Idempotency-Key'));
  });

  it('[Validação] 422 da API marca a categoria inativa e foca o campo', async () => {
    const user = userEvent.setup();
    renderList([], {
      handler: (url, init) =>
        init?.method === 'POST' && url === LIST
          ? problemResponse(422, 'VALIDATION_ERROR', {
              errors: [{ field: 'categoryId', code: 'REFERENCE_INACTIVE', message: 'inativo' }],
            })
          : undefined,
    });
    await user.click(await screen.findByRole('button', { name: 'Novo risco' }));
    const dialog = await screen.findByRole('dialog');
    await fillRequired(dialog, user);
    await user.click(
      within(dialog).getByRole('gridcell', {
        name: /Probabilidade Alta \(4\), impacto Alto \(4\)/,
      }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Salvar risco' }));
    expect(await within(dialog).findByText('Selecione uma categoria válida.')).toBeTruthy();
    expect(within(dialog).getByText('Revise os campos destacados.')).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).toBe(within(dialog).getByLabelText(/^Categoria/));
    });
  });

  it('[Sucesso] reavaliação: transição "Alto → Médio", PATCH só com o alterado e If-Match', async () => {
    const user = userEvent.setup();
    const current = risk(1);
    const PATCH = `/api/v1/risks/${current.id}`;
    const api = renderList([current], {
      handler: (url, init) =>
        init?.method === 'PATCH' && url === PATCH
          ? jsonResponse({
              data: { ...current, probability: 2, score: 8, level: 'MEDIUM', version: 4 },
            })
          : undefined,
    });
    await user.click(await screen.findByRole('button', { name: 'Editar R01' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText<HTMLInputElement>(/^Título/).value).toBe('Risco número 1');
    // Edição tem duas grades (inerente e residual): a primeira é a da avaliação.
    const [grid] = within(dialog).getAllByRole('grid');
    if (!grid) throw new Error('Formulário sem grade.');
    await user.click(
      within(grid).getByRole('gridcell', {
        name: 'Probabilidade Baixa (2), impacto Alto (4): escore 8, nível Médio',
      }),
    );
    expect(within(dialog).getByText('Nível: Alto → Médio')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Salvar risco' }));
    await waitFor(() => {
      expect(callsTo(api, 'PATCH', PATCH)).toHaveLength(1);
    });
    const [call] = callsTo(api, 'PATCH', PATCH);
    expect(call?.headers.get('If-Match')).toBe('"3"');
    expect(bodyOf(call?.init)).toEqual({ probability: 2 });
    expect(await screen.findByText('Risco R01 reavaliado: Alto → Médio')).toBeTruthy();
  });

  it('[Concorrência] 412: avisa, recarrega o risco e destaca o que mudou', async () => {
    const user = userEvent.setup();
    const current = risk(1);
    let reloaded = false;
    const api = renderList([current], {
      handler: (url, init) => {
        if (init?.method === 'PATCH') {
          reloaded = true;
          return problemResponse(412, 'VERSION_CONFLICT', { extension: { currentVersion: 4 } });
        }
        if ((init?.method ?? 'GET') === 'GET' && url === LIST && reloaded) {
          return jsonResponse({
            data: [{ ...current, title: 'Título da Carla', version: 4 }],
            meta: editableMeta,
          });
        }
        return undefined;
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Editar R01' }));
    const dialog = await screen.findByRole('dialog');
    const title = within(dialog).getByLabelText(/^Título/);
    await user.clear(title);
    await user.type(title, 'Título da Ana');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar risco' }));
    expect(
      await within(dialog).findByText(
        'Este risco foi alterado por outra pessoa. Recarregue para ver a versão atual.',
      ),
    ).toBeTruthy();
    expect(
      await within(dialog).findByText('Campos alterados por outra pessoa: Título.'),
    ).toBeTruthy();
    expect(callsTo(api, 'GET', LIST).length).toBeGreaterThan(1);
    // O formulário mantém o que a pessoa digitou; "Carregar versão atual" traz o do servidor.
    expect((title as HTMLInputElement).value).toBe('Título da Ana');
    await user.click(within(dialog).getByRole('button', { name: 'Carregar versão atual' }));
    expect(within(dialog).getByLabelText<HTMLInputElement>(/^Título/).value).toBe(
      'Título da Carla',
    );
  });

  it('[Sucesso] exclusão com tratamentos: lista-os, confirma e envia If-Match', async () => {
    const user = userEvent.setup();
    const withTreatments = risk(1, {
      treatments: [
        treatmentFixture(0, ID(901), { description: 'Exigir garantia contratual' }),
        treatmentFixture(1, ID(901), {
          type: 'CONTINGENCY',
          description: 'Acionar o segundo colocado',
          status: 'IN_PROGRESS',
        }),
      ],
    });
    const DELETE = `/api/v1/risks/${withTreatments.id}`;
    const api = renderList([withTreatments], {
      handler: (_url, init) =>
        init?.method === 'DELETE' ? new Response(null, { status: 204 }) : undefined,
    });
    await user.click(await screen.findByRole('button', { name: 'Excluir R01' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText('Este risco tem 2 ações de tratamento, que também serão excluídas:'),
    ).toBeTruthy();
    expect(within(dialog).getByText('Exigir garantia contratual')).toBeTruthy();
    expect(within(dialog).getByText('Acionar o segundo colocado')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Excluir risco e tratamentos' }));
    await waitFor(() => {
      expect(callsTo(api, 'DELETE', DELETE)).toHaveLength(1);
    });
    expect(callsTo(api, 'DELETE', DELETE)[0]?.headers.get('If-Match')).toBe('"3"');
    expect(await screen.findByText('Risco R01 excluído')).toBeTruthy();
  });

  it('exclusão sem tratamentos: confirmação simples', async () => {
    const user = userEvent.setup();
    renderList([risk(1)]);
    await user.click(await screen.findByRole('button', { name: 'Excluir R01' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText(/ação de tratamento/)).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Excluir risco' })).toBeTruthy();
  });
});

describe('SCR-011 · riscos gerados por IA (US-119 · RN-AI-42)', () => {
  const REVIEW = `${LIST}/ai-review`;
  const aiRisk = (sequence: number, extra: Partial<RiskDto> = {}) =>
    risk(sequence, { aiGenerationId: ID(900), aiReviewedAt: null, aiReviewedBy: null, ...extra });

  it('selo "Gerado por IA · revisão pendente" (com "[a confirmar]") e revisado; acessível', async () => {
    renderList([
      aiRisk(1, { cause: 'Prazo de [a confirmar: prazo] para o levantamento' }),
      aiRisk(2, {
        aiReviewedAt: '2026-10-18T12:00:00.000Z',
        aiReviewedBy: { id: ID(77), name: 'Lúcia' },
      }),
      risk(3),
    ]);
    expect(await screen.findByText(/Gerado por IA · revisão pendente/)).toBeTruthy();
    expect(screen.getByText(/há itens \[a confirmar\]/)).toBeTruthy();
    expect(screen.getByText(/Gerado por IA · revisado em/)).toBeTruthy();
    expect(screen.getAllByText(/Gerado por IA/)).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Marcar o risco R01 como revisado' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Marcar o risco R02 como revisado' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Revisar todos/ })).toBeNull();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('"Marcar como revisado" envia o RSK-12 com a versão vista e recarrega a lista', async () => {
    const user = userEvent.setup();
    const api = renderList([aiRisk(1)], {
      handler: (url, init) =>
        url.endsWith('/ai-review') && init?.method === 'POST'
          ? jsonResponse({ data: { risks: [], reviewedRiskIds: [ID(1)] } })
          : undefined,
    });
    await user.click(
      await screen.findByRole('button', { name: 'Marcar o risco R01 como revisado' }),
    );
    await waitFor(() => {
      expect(callsTo(api, 'POST', REVIEW)).toHaveLength(1);
    });
    const [call] = callsTo(api, 'POST', REVIEW);
    const body = bodyOf(call?.init);
    expect(body.riskIds).toHaveLength(1);
    expect(Object.values(body.expectedVersions as Record<string, number>)).toEqual([3]);
    expect(await screen.findByText('Risco R01 marcado como revisado.')).toBeTruthy();
    await waitFor(() => {
      expect(callsTo(api, 'GET', LIST).length).toBeGreaterThan(1);
    });
  });

  it('"Revisar todos" com 2+ pendentes: confirmação explícita; 412 avisa que o risco mudou', async () => {
    const user = userEvent.setup();
    const api = renderList([aiRisk(1), aiRisk(2)], {
      handler: (url, init) =>
        url.endsWith('/ai-review') && init?.method === 'POST'
          ? problemResponse(412, 'VERSION_CONFLICT')
          : undefined,
    });
    await user.click(await screen.findByRole('button', { name: 'Revisar todos (2)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Revisar os riscos gerados por IA' });
    const confirm = within(dialog).getByRole('button', {
      name: 'Marcar os 2 riscos como revisados',
    });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    await user.click(within(dialog).getByRole('checkbox', { name: 'Li e revisei os 2 riscos' }));
    await user.click(confirm);
    await waitFor(() => {
      expect(callsTo(api, 'POST', REVIEW)).toHaveLength(1);
    });
    expect(bodyOf(callsTo(api, 'POST', REVIEW)[0]?.init).riskIds).toHaveLength(2);
    expect(
      await within(dialog).findByText('O risco foi alterado por outra pessoa. Recarregue.'),
    ).toBeTruthy();
  });
});
