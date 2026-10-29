// @vitest-environment jsdom
import type { AiGenerationDto, AiProposedRisk } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { ID, PROCESS_ID, problemResponse } from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { AiAssistant } from './ai-assistant';
import { pendingParts } from './ai-assistant-panel';
import { applyBodyOf, defaultRiskSelection, highWithoutTreatment } from './ai-risk-proposal-list';

configure({ asyncUtilTimeout: 8000 });
vi.setConfig({ testTimeout: 30_000 });

/*
 * US-119 — SCR-117 no SCR-011: a proposta de riscos (`AiRiskProposalList`) com P×I e nível pela
 * escala vigente, parecidos desmarcados (FA-02), aviso de risco Alto sem tratamento (FA-06), RSK-11
 * com `Idempotency-Key` só com os riscos e tratamentos marcados, proposta não aplicável (409) e a
 * proposta de outra pessoa somente leitura.
 */

const ME = '0192a000-0000-7000-8000-0000000000a1';
const GEN = ID(901);
const EXISTING = ID(902);
const THRESHOLDS = [
  { level: 'LOW' as const, minScore: 1, maxScore: 4 },
  { level: 'MEDIUM' as const, minScore: 5, maxScore: 9 },
  { level: 'HIGH' as const, minScore: 10, maxScore: 16 },
  { level: 'EXTREME' as const, minScore: 17, maxScore: 25 },
];

function proposedRisk(key: string, fields: Partial<AiProposedRisk> = {}): AiProposedRisk {
  return {
    proposalKey: key,
    title: `Risco ${key}`,
    description: '',
    categoryCode: 'PRAZO',
    phase: 'PLANNING',
    cause: `Causa do risco ${key}.`,
    consequence: `Consequência do risco ${key}.`,
    probability: 2,
    impact: 2,
    rationale: `Motivo do risco ${key}.`,
    treatments: [
      { proposalKey: `${key}.T1`, type: 'PREVENTIVE', description: `Prevenção do risco ${key}.` },
      {
        proposalKey: `${key}.T2`,
        type: 'CONTINGENCY',
        description: `Contingência do risco ${key}.`,
      },
    ],
    ...fields,
  };
}

const RISKS = [
  proposedRisk('R1', { title: 'Especificação insuficiente', probability: 3, impact: 4 }),
  proposedRisk('R2', { title: 'Fornecedores insuficientes', similarToRiskId: EXISTING }),
];

function proposal(extra: Partial<AiGenerationDto> = {}): AiGenerationDto {
  return {
    id: GEN,
    processId: PROCESS_ID,
    documentId: null,
    targetModule: 'RISK_MAP',
    kind: 'DRAFT',
    action: null,
    sectionKey: null,
    baseRevision: null,
    status: 'SUCCEEDED',
    requestedBy: { id: ME, name: 'Ana Souza' },
    createdAt: '2026-10-18T12:00:00.000Z',
    startedAt: '2026-10-18T12:00:01.000Z',
    completedAt: '2026-10-18T12:01:00.000Z',
    expiresAt: '2026-10-25T12:01:00.000Z',
    provider: 'fake',
    model: 'fake-draft-1',
    promptKey: 'draft.risk_map',
    promptVersion: '1.0.0',
    usage: { inputTokens: 900, outputTokens: 300, totalTokens: 1200 },
    placeholdersCount: 0,
    groundingReplacements: 0,
    inputRefs: [],
    output: {
      sections: [],
      risks: RISKS,
      warnings: [{ code: 'MISSING_OPTIONAL_INPUT', params: { input: 'ETP' } }],
    },
    errorCode: null,
    appliedAt: null,
    appliedTargets: null,
    ...extra,
  };
}

function mockApi(options: { generation?: AiGenerationDto; apply?: () => Response } = {}) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/v1/me/permissions')) {
      return Promise.resolve(
        jsonResponse({
          data: {
            permissions: ['AI_GENERATE', 'PROCESS_VIEW', 'RISK_MANAGE'].map((code) => ({
              code,
              scopes: [{ type: 'TENANT', includeSubtree: false }],
            })),
            implicit: { headOfDepartmentIds: [], ownDepartmentIds: [] },
          },
        }),
      );
    }
    if (method === 'GET' && url.startsWith('/api/v1/ai/availability')) {
      return Promise.resolve(
        jsonResponse({
          data: {
            enabled: true,
            providerAvailable: true,
            canGenerate: true,
            reasons: [],
            monthly: { percentUsed: 10 },
            userDaily: { used: 1, limit: 40 },
          },
        }),
      );
    }
    if (method === 'GET' && url.startsWith('/api/v1/catalogs/RISK_CATEGORY/items')) {
      return Promise.resolve(
        jsonResponse({
          data: [
            {
              id: ID(950),
              catalogType: 'RISK_CATEGORY',
              code: 'PRAZO',
              label: 'Prazo',
              isActive: true,
            },
          ],
          meta: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 },
        }),
      );
    }
    if (method === 'GET' && url === `/api/v1/ai-generations/${GEN}`) {
      return Promise.resolve(jsonResponse({ data: options.generation ?? proposal() }));
    }
    if (method === 'POST' && url === `/api/v1/processes/${PROCESS_ID}/risks/ai-apply`) {
      if (options.apply) return Promise.resolve(options.apply());
      return Promise.resolve(jsonResponse({ data: { risks: [] } }, { status: 201 }));
    }
    if (method === 'GET' && url.startsWith(`/api/v1/processes/${PROCESS_ID}/ai-generations`)) {
      return Promise.resolve(
        jsonResponse({ data: [], meta: { nextCursor: null, hasMore: false } }),
      );
    }
    return Promise.resolve(jsonResponse({}, { status: 404 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const applyCalls = (fetchMock: ReturnType<typeof mockApi>) =>
  fetchMock.mock.calls
    .filter(([input, init]) => init?.method === 'POST' && requestUrl(input).endsWith('/ai-apply'))
    .map(([, init]) => ({
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
        string,
        unknown
      >,
      headers: new Headers(init?.headers),
    }));

async function openProposal(onRisksApplied = vi.fn()) {
  renderWithShell(
    <AiAssistant
      processId={PROCESS_ID}
      documentId={null}
      targetModule="RISK_MAP"
      editable
      initialGenerationId={GEN}
      riskContext={{
        levelThresholds: THRESHOLDS,
        existing: [{ id: EXISTING, code: 'R03' }],
        onRisksApplied,
      }}
    />,
  );
  const panel = await screen.findByRole('dialog', {
    name: 'Assistente de redação com IA',
  });
  return { panel, onRisksApplied };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Proposta de riscos — regras puras (US-119)', () => {
  it('parecidos com risco existente vêm desmarcados; todos os tratamentos marcados', () => {
    const selection = defaultRiskSelection(RISKS);
    expect([...selection.risks]).toEqual(['R1']);
    expect([...selection.treatments]).toEqual(['R1.T1', 'R1.T2', 'R2.T1', 'R2.T2']);
    expect(applyBodyOf(GEN, RISKS, selection)).toEqual({
      generationId: GEN,
      risks: [{ proposalKey: 'R1', treatments: ['R1.T1', 'R1.T2'] }],
    });
  });

  it('FA-06: risco Alto marcado sem tratamento é avisado', () => {
    const selection = { risks: new Set(['R1', 'R2']), treatments: new Set(['R2.T1']) };
    expect(highWithoutTreatment(RISKS, selection, THRESHOLDS)).toEqual([
      'Especificação insuficiente',
    ]);
  });

  it('partes pendentes: riscos e seções são aplicados uma vez cada (APPLIED aceita a outra parte)', () => {
    const withSections = proposal({
      documentId: ID(903),
      output: {
        sections: [
          {
            sectionKey: 'INTRODUCTION',
            title: 'Introdução',
            content: { type: 'doc', content: [] },
            placeholdersCount: 0,
            groundingReplacements: 0,
          },
        ],
        risks: RISKS,
        warnings: [],
      },
    });
    expect(pendingParts(withSections, ID(903))).toEqual({ risks: true, sections: true });
    expect(
      pendingParts(
        {
          ...withSections,
          status: 'APPLIED',
          appliedTargets: { sectionKeys: [], riskIds: [ID(1)] },
        },
        ID(903),
      ),
    ).toEqual({ risks: false, sections: true });
    expect(pendingParts(proposal(), null)).toEqual({ risks: true, sections: false });
    expect(pendingParts(proposal({ status: 'EXPIRED' }), null)).toEqual({
      risks: false,
      sections: false,
    });
  });
});

describe('SCR-117 no SCR-011 — aplicar a proposta de riscos (US-119)', () => {
  it('cartões com nível pela escala vigente, selo "Parecido com R03" desmarcado e aviso de entrada ausente; acessível', async () => {
    mockApi();
    const { panel } = await openProposal();
    const first = await within(panel).findByRole('checkbox', {
      name: 'Especificação insuficiente',
    });
    expect(first.getAttribute('aria-checked')).toBe('true');
    expect(
      within(panel)
        .getByRole('checkbox', { name: 'Fornecedores insuficientes' })
        .getAttribute('aria-checked'),
    ).toBe('false');
    expect(within(panel).getByText('Parecido com R03')).toBeTruthy();
    expect(within(panel).getByText('Alto')).toBeTruthy();
    expect(within(panel).getByText('P 3 × I 4')).toBeTruthy();
    expect(within(panel).getByText(/O processo ainda não tem ETP/)).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Aplicar 1 risco' })).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('aplica só o marcado (RSK-11 com Idempotency-Key), avisa Alto sem tratamento e recarrega a lista', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi();
    const { panel, onRisksApplied } = await openProposal();
    await within(panel).findByRole('checkbox', { name: 'Especificação insuficiente' });
    await user.click(within(panel).getByRole('checkbox', { name: /Prevenção do risco R1/ }));
    await user.click(within(panel).getByRole('checkbox', { name: /Contingência do risco R1/ }));
    expect(within(panel).getByText(/sem tratamento marcado/)).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Aplicar 1 risco' }));
    await waitFor(() => {
      expect(applyCalls(fetchMock)).toHaveLength(1);
    });
    const [call] = applyCalls(fetchMock);
    expect(call?.body).toEqual({
      generationId: GEN,
      risks: [{ proposalKey: 'R1', treatments: [] }],
    });
    expect(call?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => {
      expect(onRisksApplied).toHaveBeenCalledTimes(1);
    });
  });

  it('sem seleção: "Selecione ao menos um risco"; proposta não aplicável (409): mensagem e nada aplicado', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi({
      apply: () => problemResponse(409, 'AI_GENERATION_NOT_APPLICABLE'),
    });
    const { panel } = await openProposal();
    const first = await within(panel).findByRole('checkbox', {
      name: 'Especificação insuficiente',
    });
    await user.click(first);
    await user.click(within(panel).getByRole('button', { name: 'Aplicar selecionados' }));
    expect(await within(panel).findByText('Selecione ao menos um risco da proposta.')).toBeTruthy();
    expect(applyCalls(fetchMock)).toHaveLength(0);
    await user.click(first);
    await user.click(within(panel).getByRole('button', { name: 'Aplicar 1 risco' }));
    expect(
      await within(panel).findByText('Esta proposta não pode mais ser aplicada. Gere outra.'),
    ).toBeTruthy();
  });

  it('proposta de outra pessoa: somente leitura, sem aplicar', async () => {
    mockApi({ generation: proposal({ requestedBy: { id: ID(77), name: 'Lúcia' } }) });
    const { panel } = await openProposal();
    expect(await within(panel).findByText(/Proposta de outra pessoa/)).toBeTruthy();
    expect(within(panel).getByText('Especificação insuficiente')).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: /Aplicar/ })).toBeNull();
  });
});
