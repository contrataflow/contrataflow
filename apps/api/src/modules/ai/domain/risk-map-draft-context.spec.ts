import { describe, expect, it } from 'vitest';

import { sanitizeContext } from './context-sanitizer.js';
import {
  assembleRiskMapDraftContext,
  normalizeRiskProposal,
  riskMapDraftSections,
  riskMapResponseSchema,
} from './risk-map-draft-context.js';
import type { RiskMapDraftSources } from './risk-map-draft-context.js';

const PROCESS_ID = '0192d200-0000-7000-8000-000000000001';
const DFD_ID = '0192d200-0000-7000-8000-000000000002';
const ETP_ID = '0192d200-0000-7000-8000-000000000003';
const MAP_ID = '0192d200-0000-7000-8000-000000000004';
const RISK_ID = '0192d200-0000-7000-8000-000000000005';

const providerRisk = (fields: Record<string, unknown> = {}) => ({
  title: 'Atraso na entrega',
  description: 'O fornecedor pode atrasar a entrega.',
  categoryCode: 'PRAZO',
  phase: 'CONTRACT_MANAGEMENT',
  cause: 'Dificuldade logística do fornecedor.',
  consequence: 'Interrupção do serviço público.',
  probability: 3,
  impact: 4,
  rationale: 'Mercado restrito.',
  treatments: [
    { type: 'PREVENTIVE', description: 'Definir marcos de acompanhamento da entrega.' },
    { type: 'CONTINGENCY', description: 'Aplicar as sanções e acionar o segundo colocado.' },
  ],
  ...fields,
});

function sources(overrides: Partial<RiskMapDraftSources> = {}): RiskMapDraftSources {
  return {
    process: {
      id: PROCESS_ID,
      code: '0012/2026',
      title: 'Computadores para as escolas',
      object: 'Aquisição de computadores',
      description: null,
      contractingType: 'Aquisição de bens',
      modality: null,
      isPriceRegistration: false,
      priority: 'HIGH',
      isBudgetConfidential: false,
    },
    dfd: {
      documentId: DFD_ID,
      documentTypeCode: 'DFD',
      source: 'APPROVED_VERSION',
      versionNumber: 2,
      draftRevision: null,
      sections: [{ key: 'JUSTIFICATION', text: 'Laboratórios com equipamentos obsoletos.' }],
    },
    etp: null,
    termOfReference: null,
    risks: [],
    categories: [
      { code: 'PRAZO', label: 'Prazo' },
      { code: 'OUTRO', label: 'Outro' },
    ],
    scale: {
      max: 5,
      probabilityLabels: ['a', 'b', 'c', 'd', 'e'],
      impactLabels: ['a', 'b', 'c', 'd', 'e'],
    },
    riskMap: null,
    ...overrides,
  };
}

const rules = {
  scaleMax: 5,
  categoryCodes: new Set(['PRAZO', 'OUTRO']),
  existingRisks: new Map([['R01', RISK_ID]]),
};

describe('RiskMapProposalContextAssembler (US-119 · RN-AI-38/41)', () => {
  it('DFD obrigatório; ETP e TR ausentes geram MISSING_OPTIONAL_INPUT; sem documento, só riscos', () => {
    const context = assembleRiskMapDraftContext(sources());
    expect(context.parts.map((part) => part.ref.kind)).toEqual([
      'PROCESS',
      'CATALOG',
      'DOCUMENT_VERSION',
      'RISKS',
    ]);
    expect(context.parts[2]?.ref).toMatchObject({
      id: DFD_ID,
      documentTypeCode: 'DFD',
      versionNumber: 2,
    });
    expect(context.warnings).toEqual([
      { code: 'MISSING_OPTIONAL_INPUT', params: { input: 'ETP' } },
      { code: 'MISSING_OPTIONAL_INPUT', params: { input: 'TERM_OF_REFERENCE' } },
    ]);
    expect(context.sections).toEqual([]);
    expect(context.ignoreUnknownSections).toBe(true);
  });

  it('rascunho entra com USED_DRAFT_INPUTS; seções de valor e valores nunca entram (RN-AI-05)', () => {
    const context = assembleRiskMapDraftContext(
      sources({
        etp: {
          documentId: ETP_ID,
          documentTypeCode: 'ETP',
          source: 'DRAFT',
          versionNumber: null,
          draftRevision: 7,
          sections: [
            { key: 'SOLUTION', text: 'Solução escolhida: compra direta de equipamentos.' },
            { key: 'ESTIMATES', text: 'Estimativa de R$ 150.000,00.' },
          ],
        },
      }),
    );
    expect(context.warnings).toContainEqual({
      code: 'USED_DRAFT_INPUTS',
      params: { input: 'ETP' },
    });
    const etp = context.parts.find((part) => part.ref.id === ETP_ID);
    expect(etp?.ref).toMatchObject({ kind: 'DOCUMENT_DRAFT', revision: 7 });
    expect(etp?.optional).toBe(true);
    const serialized = JSON.stringify(context.parts);
    expect(serialized).not.toContain('150.000');
    expect(serialized).not.toContain('ESTIMATES');
  });

  it('riscos já registrados entram com id, código, categoria, fase, nível e tratamentos; nada de pessoa', () => {
    const context = assembleRiskMapDraftContext(
      sources({
        risks: [
          {
            id: RISK_ID,
            code: 'R01',
            title: 'Licitação deserta',
            categoryCode: 'MERCADO_FORNECEDOR',
            phase: 'SELECTION',
            level: 'HIGH',
            treatments: [
              { type: 'PREVENTIVE', description: 'Revisar as exigências de habilitação.' },
            ],
          },
        ],
      }),
    );
    const sanitized = sanitizeContext(context.parts, {
      isBudgetConfidential: false,
      maxChars: 100_000,
    });
    const risks = sanitized.parts.find((part) => part.ref.kind === 'RISKS');
    expect(risks?.data).toEqual([
      {
        codigo: 'R01',
        titulo: 'Licitação deserta',
        categoria: 'MERCADO_FORNECEDOR',
        fase: 'Seleção do fornecedor',
        nivel: 'Alto',
        tratamentos: [{ tipo: 'Prevenção', descricao: 'Revisar as exigências de habilitação.' }],
      },
    ]);
  });

  it('com o RISK_MAP emitido, pede INTRODUCTION/METHODOLOGY/NOTES (NOTES opcional), nunca as computadas', () => {
    const template = [
      {
        key: 'INTRODUCTION',
        title: 'Introdução',
        requirement: 'REQUIRED' as const,
        helpText: null,
        legalBasis: 'Lei 14.133/2021, art. 18, X',
        maxChars: 50_000,
        allowNarrative: true,
      },
      {
        key: 'METHODOLOGY',
        title: 'Metodologia',
        requirement: 'REQUIRED' as const,
        helpText: null,
        legalBasis: null,
        maxChars: 50_000,
        allowNarrative: true,
      },
      {
        key: 'RISK_MATRIX',
        title: 'Matriz',
        requirement: 'REQUIRED' as const,
        helpText: null,
        legalBasis: null,
        maxChars: 50_000,
        allowNarrative: false,
      },
      {
        key: 'NOTES',
        title: 'Observações',
        requirement: 'OPTIONAL' as const,
        helpText: null,
        legalBasis: null,
        maxChars: 50_000,
        allowNarrative: true,
      },
    ];
    const context = assembleRiskMapDraftContext(
      sources({
        riskMap: {
          documentId: MAP_ID,
          documentTypeCode: 'RISK_MAP',
          draftRevision: 3,
          sectionStates: { INTRODUCTION: 'EMPTY', METHODOLOGY: 'FILLED' },
          template: { versionId: MAP_ID, versionNumber: 1, sections: template },
        },
      }),
    );
    expect(
      context.sections.map((section) => [section.sectionKey, section.optional ?? false]),
    ).toEqual([
      ['INTRODUCTION', false],
      ['METHODOLOGY', false],
      ['NOTES', true],
    ]);
    expect(context.ignoreUnknownSections).toBe(false);
    expect(context.parts.map((part) => part.ref.kind)).toContain('TEMPLATE_VERSION');
    expect(riskMapDraftSections(null)).toEqual([]);
  });
});

describe('RiskProposalNormalizer (RN-AI-39)', () => {
  it('atribui as chaves, troca categoria desconhecida por OUTRO e descarta similarToRiskId desconhecido', () => {
    const result = normalizeRiskProposal(
      [
        providerRisk({ similarToRiskCode: 'R01' }),
        providerRisk({ categoryCode: 'INEXISTENTE', similarToRiskCode: 'R09' }),
      ],
      rules,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.risks.map((risk) => [risk.proposalKey, risk.categoryCode, risk.similarToRiskId]),
    ).toEqual([
      ['R1', 'PRAZO', RISK_ID],
      ['R2', 'OUTRO', undefined],
    ]);
    expect(result.risks[0]?.treatments.map((treatment) => treatment.proposalKey)).toEqual([
      'R1.T1',
      'R1.T2',
    ]);
  });

  it('grau acima da escala vigente, risco sem tratamento, mais de 15 riscos ou campo de responsável = saída inválida', () => {
    expect(
      normalizeRiskProposal([providerRisk({ probability: 4, impact: 2 })], {
        ...rules,
        scaleMax: 3,
      }),
    ).toEqual({
      ok: false,
      issues: ['risks.0.probability: out_of_scale'],
    });
    expect(normalizeRiskProposal([providerRisk({ treatments: [] })], rules).ok).toBe(false);
    expect(
      normalizeRiskProposal(
        Array.from({ length: 16 }, () => providerRisk()),
        rules,
      ).ok,
    ).toBe(true);
    expect(
      riskMapResponseSchema.safeParse({
        sections: [],
        risks: Array.from({ length: 16 }, () => providerRisk()),
      }).success,
    ).toBe(false);
    expect(normalizeRiskProposal([providerRisk({ ownerName: 'Fulano' })], rules).ok).toBe(false);
    expect(normalizeRiskProposal([providerRisk({ probability: 7 })], rules).ok).toBe(false);
    expect(normalizeRiskProposal(undefined, rules).ok).toBe(false);
  });

  it('o schema da resposta aceita a proposta sem seções e recusa risco com prazo do tratamento', () => {
    expect(riskMapResponseSchema.safeParse({ sections: [], risks: [providerRisk()] }).success).toBe(
      true,
    );
    const withDueDate = providerRisk({
      treatments: [
        {
          type: 'PREVENTIVE',
          description: 'Revisar a especificação técnica.',
          dueDate: '2026-12-01',
        },
      ],
    });
    expect(riskMapResponseSchema.safeParse({ sections: [], risks: [withDueDate] }).success).toBe(
      false,
    );
  });
});
