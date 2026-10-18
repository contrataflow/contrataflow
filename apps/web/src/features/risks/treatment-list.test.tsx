// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import type { RiskDto, RiskListMetaDto, RiskTreatmentDto } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeQueryClient } from '@/lib/query/query-client';
import { seriousA11yViolations } from '@test/support/axe';
import {
  ID,
  PROCESS_ID,
  callsTo,
  catalogItem,
  mockProcessApi,
  problemResponse,
} from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell } from '@test/support/render';
import { treatmentFixture } from '@test/support/risk-fixtures';

import { RiskList } from './risk-list';
import { localToday } from './treatments-model';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

const RISK_ID = ID(901);
const POST = `/api/v1/risks/${RISK_ID}/treatments`;
const ITEM = (id: string) => `/api/v1/risk-treatments/${id}`;
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

/** `YYYY-MM-DD` a `days` dias de hoje (fuso local — o mesmo do destaque de prazo). */
function inDays(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return localToday(date);
}

function riskWith(treatments: readonly RiskTreatmentDto[]): RiskDto {
  return {
    id: RISK_ID,
    processId: PROCESS_ID,
    code: 'R01',
    title: 'Fornecedores insuficientes',
    description: null,
    categoryId: CATEGORY.id,
    category: { id: CATEGORY.id, code: CATEGORY.code, label: CATEGORY.label },
    phase: 'PLANNING',
    cause: 'Mercado local com poucos fornecedores',
    consequence: 'Licitação deserta',
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
    status: treatments.length === 0 ? 'OPEN' : 'IN_TREATMENT',
    sortOrder: 0,
    treatments: [...treatments],
    version: 2,
  };
}

type Route = (url: string, init?: RequestInit) => Response | undefined;

const noRetryClient = () => {
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
  return client;
};

/** Renderiza a lista de riscos e expande o R01 (painel com as ações de tratamento). */
async function renderPanel(
  treatments: readonly RiskTreatmentDto[],
  options: { meta?: Partial<RiskListMetaDto>; handler?: Route } = {},
) {
  const user = userEvent.setup();
  const api = mockProcessApi({
    permissions: ['PROCESS_VIEW'],
    catalogs: { RISK_CATEGORY: [CATEGORY] },
    risks: (url, init) => {
      const handled = options.handler?.(url, init);
      if (handled) return handled;
      return jsonResponse({
        data: [riskWith(treatments)],
        meta: { ...editableMeta, ...options.meta },
      });
    },
    participants: () => jsonResponse({ data: [], meta: {} }),
  });
  renderWithShell(
    <>
      <RiskList processId={PROCESS_ID} />
      <Toaster />
    </>,
    { queryClient: noRetryClient() },
  );
  await user.click(await screen.findByRole('button', { name: 'Ver detalhes R01' }));
  const panel = screen.getByRole('region', { name: 'Ações de tratamento' });
  return { api, user, panel };
}

describe('SCR-011 · ações de tratamento (US-034)', () => {
  it('[Estado] vazio: orientação e "Nova ação de tratamento"', async () => {
    const { panel } = await renderPanel([]);
    expect(
      within(panel).getByText('Nenhuma ação de tratamento. Adicione a primeira ação.'),
    ).toBeTruthy();
    expect(
      within(panel).getByRole('button', { name: 'Nova ação de tratamento para R01' }),
    ).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('[Sucesso] criar: validação local com o schema da API, POST com Idempotency-Key e toast', async () => {
    const created = treatmentFixture(1, RISK_ID);
    const { api, user, panel } = await renderPanel([], {
      handler: (url, init) =>
        init?.method === 'POST' && url === POST
          ? jsonResponse({ data: created }, { status: 201, headers: { ETag: '"1"' } })
          : undefined,
    });
    await user.click(
      within(panel).getByRole('button', { name: 'Nova ação de tratamento para R01' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Nova ação de tratamento — R01' });

    await user.click(within(dialog).getByRole('button', { name: 'Salvar ação' }));
    expect(await within(dialog).findByText('Informe o tipo.')).toBeTruthy();
    expect(within(dialog).getByText('Informe a descrição.')).toBeTruthy();
    expect(callsTo(api, 'POST', POST)).toEqual([]);

    await user.selectOptions(within(dialog).getByLabelText(/^Tipo/), 'PREVENTIVE');
    await user.type(within(dialog).getByLabelText(/^Descrição/), 'curta');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar ação' }));
    expect(
      await within(dialog).findByText('A descrição deve ter entre 10 e 1.000 caracteres.'),
    ).toBeTruthy();

    await user.type(within(dialog).getByLabelText(/^Descrição/), ' demais para valer');
    await user.type(within(dialog).getByLabelText('Prazo'), '2026-11-30');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar ação' }));
    await waitFor(() => {
      expect(callsTo(api, 'POST', POST)).toHaveLength(1);
    });
    const [call] = callsTo(api, 'POST', POST);
    expect(call?.headers.get('Idempotency-Key')).toBeTruthy();
    expect(call?.body).toEqual({
      type: 'PREVENTIVE',
      description: 'curta demais para valer',
      dueDate: '2026-11-30',
    });
    expect(await screen.findByText('Ação de tratamento adicionada ao risco R01')).toBeTruthy();
  });

  it('lista: tipo, responsável, prazo com "Atrasado"/"Vence em…" (FA-03) e status final como texto', async () => {
    const { panel } = await renderPanel([
      treatmentFixture(1, RISK_ID, {
        dueDate: inDays(-2),
        responsible: { id: ID(1), name: 'Ana Souza' },
        responsibleId: ID(1),
        notes: 'Combinar com a comunicação',
      }),
      treatmentFixture(2, RISK_ID, { type: 'CONTINGENCY', dueDate: inDays(3) }),
      treatmentFixture(3, RISK_ID, {
        status: 'DONE',
        dueDate: inDays(-10),
        completedAt: '2026-10-18T12:00:00.000Z',
      }),
    ]);
    const items = within(panel).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    const item = (index: number) => {
      const found = items[index];
      if (!found) throw new Error(`item ${String(index)} ausente`);
      return found;
    };
    expect(within(item(0)).getByText('Prevenção')).toBeTruthy();
    expect(within(item(0)).getByText('Atrasado')).toBeTruthy();
    expect(within(item(0)).getByText('Ana Souza')).toBeTruthy();
    expect(within(item(0)).getByText('Combinar com a comunicação')).toBeTruthy();
    expect(within(item(1)).getByText('Contingência')).toBeTruthy();
    expect(within(item(1)).getByText('Vence em 3 dias')).toBeTruthy();
    expect(within(item(1)).getByText('Sem responsável')).toBeTruthy();
    // Concluída: sem destaque de atraso e sem seletor (terminal — RN-RISK-15).
    expect(within(item(2)).queryByText('Atrasado')).toBeNull();
    expect(within(item(2)).getByText('Concluída em 18/10/2026')).toBeTruthy();
    expect(within(item(2)).getByText('Status final; não pode ser alterado.')).toBeTruthy();
    expect(within(item(2)).queryByRole('combobox')).toBeNull();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('[Sucesso] atualizar status: só as transições permitidas e PATCH com If-Match', async () => {
    const planned = treatmentFixture(1, RISK_ID, { version: 4 });
    const { api, user, panel } = await renderPanel([planned], {
      handler: (url, init) =>
        init?.method === 'PATCH' && url === ITEM(planned.id)
          ? jsonResponse({ data: { ...planned, status: 'IN_PROGRESS', version: 5 } })
          : undefined,
    });
    const select = within(panel).getByRole('combobox', { name: 'Status da ação 1 do risco R01' });
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Planejada', 'Em andamento', 'Cancelada']);
    await user.selectOptions(select, 'IN_PROGRESS');
    await waitFor(() => {
      expect(callsTo(api, 'PATCH', ITEM(planned.id))).toHaveLength(1);
    });
    const [call] = callsTo(api, 'PATCH', ITEM(planned.id));
    expect(call?.headers.get('If-Match')).toBe('"4"');
    expect(call?.body).toEqual({ status: 'IN_PROGRESS' });
    expect(await screen.findByText('Status alterado para Em andamento')).toBeTruthy();
  });

  it('[Validação] 409 INVALID_STATE: mostra a mensagem e recarrega (a seleção volta à do servidor)', async () => {
    const started = treatmentFixture(1, RISK_ID, { status: 'IN_PROGRESS' });
    const { api, user, panel } = await renderPanel([started], {
      handler: (url, init) =>
        init?.method === 'PATCH' && url === ITEM(started.id)
          ? problemResponse(409, 'INVALID_STATE', {
              detail: 'Não é possível mudar o status de Em andamento para Concluída.',
            })
          : undefined,
    });
    const list = `/api/v1/processes/${PROCESS_ID}/risks`;
    const before = callsTo(api, 'GET', list).length;
    await user.selectOptions(
      within(panel).getByRole('combobox', { name: 'Status da ação 1 do risco R01' }),
      'DONE',
    );
    expect(
      await screen.findByText('Não é possível mudar o status de Em andamento para Concluída.'),
    ).toBeTruthy();
    await waitFor(() => {
      expect(callsTo(api, 'GET', list).length).toBeGreaterThan(before);
    });
  });

  it('[Concorrência] 412 na edição: aviso "alterada por outra pessoa" e recarrega a lista', async () => {
    const treatment = treatmentFixture(1, RISK_ID);
    const { user, panel } = await renderPanel([treatment], {
      handler: (url, init) =>
        init?.method === 'PATCH' && url === ITEM(treatment.id)
          ? problemResponse(412, 'VERSION_CONFLICT')
          : undefined,
    });
    await user.click(within(panel).getByRole('button', { name: 'Editar a ação 1 do risco R01' }));
    const dialog = await screen.findByRole('dialog', { name: 'Editar ação de tratamento — R01' });
    await user.type(within(dialog).getByLabelText('Observações'), 'Nova observação');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar ação' }));
    expect(
      await within(dialog).findByText(
        'Esta ação foi alterada por outra pessoa. Recarregue para ver a versão atual.',
      ),
    ).toBeTruthy();
  });

  it('[Falha de banco] 503 na criação mantém os dados e "Tentar novamente" reaproveita a chave', async () => {
    let attempts = 0;
    const { api, user, panel } = await renderPanel([], {
      handler: (url, init) => {
        if (init?.method !== 'POST' || url !== POST) return undefined;
        attempts += 1;
        return attempts === 1
          ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE')
          : jsonResponse({ data: treatmentFixture(1, RISK_ID) }, { status: 201 });
      },
    });
    await user.click(
      within(panel).getByRole('button', { name: 'Nova ação de tratamento para R01' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText(/^Tipo/), 'CONTINGENCY');
    await user.type(within(dialog).getByLabelText(/^Descrição/), 'Contratação emergencial');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar ação' }));
    expect(
      await within(dialog).findByText(
        'Não foi possível salvar agora. Tente novamente em instantes.',
      ),
    ).toBeTruthy();
    expect(within(dialog).getByLabelText<HTMLTextAreaElement>(/^Descrição/).value).toBe(
      'Contratação emergencial',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => {
      expect(callsTo(api, 'POST', POST)).toHaveLength(2);
    });
    const [first, second] = callsTo(api, 'POST', POST);
    expect(second?.headers.get('Idempotency-Key')).toBe(first?.headers.get('Idempotency-Key'));
  });

  it('[Sucesso] reordenar (FA-02) e excluir com If-Match', async () => {
    const first = treatmentFixture(1, RISK_ID);
    const second = treatmentFixture(2, RISK_ID, { version: 3 });
    const { api, user, panel } = await renderPanel([first, second], {
      handler: (url, init) => {
        if (init?.method === 'PATCH') return jsonResponse({ data: first });
        if (init?.method === 'DELETE' && url === ITEM(first.id)) {
          return new Response(null, { status: 204 });
        }
        return undefined;
      },
    });
    expect(
      within(panel)
        .getByRole('button', { name: 'Mover a ação 1 do risco R01 para cima' })
        .hasAttribute('disabled'),
    ).toBe(true);
    await user.click(
      within(panel).getByRole('button', { name: 'Mover a ação 2 do risco R01 para cima' }),
    );
    await waitFor(() => {
      expect(callsTo(api, 'PATCH', ITEM(first.id))).toHaveLength(1);
    });
    expect(callsTo(api, 'PATCH', ITEM(second.id))[0]).toMatchObject({
      body: { sortOrder: 0 },
    });
    expect(callsTo(api, 'PATCH', ITEM(second.id))[0]?.headers.get('If-Match')).toBe('"3"');
    expect(callsTo(api, 'PATCH', ITEM(first.id))[0]).toMatchObject({ body: { sortOrder: 1 } });
    expect(await screen.findByText('Ordem das ações atualizada')).toBeTruthy();

    await user.click(within(panel).getByRole('button', { name: 'Excluir a ação 1 do risco R01' }));
    const dialog = await screen.findByRole('dialog', { name: 'Excluir a ação de tratamento?' });
    expect(within(dialog).getByText(/prefira mudar o status para Cancelada/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Excluir ação' }));
    await waitFor(() => {
      expect(callsTo(api, 'DELETE', ITEM(first.id))).toHaveLength(1);
    });
    expect(callsTo(api, 'DELETE', ITEM(first.id))[0]?.headers.get('If-Match')).toBe('"1"');
    expect(await screen.findByText('Ação de tratamento excluída')).toBeTruthy();
  });

  it('[Permissão] sem permissão: nenhuma ação e status só como texto', async () => {
    const { panel } = await renderPanel([treatmentFixture(1, RISK_ID)], {
      meta: { canManage: false, lockReason: 'PERMISSION_DENIED' },
    });
    expect(within(panel).queryByRole('button')).toBeNull();
    expect(within(panel).queryByRole('combobox')).toBeNull();
    expect(within(panel).getByText('Planejada')).toBeTruthy();
  });

  it('[FA-05] Mapa de Riscos concluído: ações visíveis porém desabilitadas', async () => {
    const { panel } = await renderPanel([treatmentFixture(1, RISK_ID)], {
      meta: {
        canManage: false,
        lockReason: 'DOCUMENT_NOT_EDITABLE',
        riskMap: { id: ID(777), code: 'MR 0001/2026', status: 'FINALIZED' },
      },
    });
    expect(
      within(panel)
        .getByRole('button', { name: 'Nova ação de tratamento para R01' })
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(
      within(panel)
        .getByRole('button', { name: 'Editar a ação 1 do risco R01' })
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(within(panel).queryByRole('combobox')).toBeNull();
  });
});
