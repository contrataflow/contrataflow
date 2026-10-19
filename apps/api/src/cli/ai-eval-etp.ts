import { assembleEtpDraftContext } from '#modules/ai/domain/etp-draft-context.js';
import type { EtpDraftSources } from '#modules/ai/domain/etp-draft-context.js';
import type { SectionSpec } from '#modules/ai/domain/output-converter.js';
import type { PromptTemplate } from '#modules/ai/domain/prompts.js';
import { ETP_DRAFT_PROMPT } from '#modules/ai/prompts/draft.etp/prompt.js';

import type { SyntheticProcess } from './ai-eval.js';

/*
 * Suíte `draft.etp` do `pnpm ai:eval --suite etp` (US-118 · "Impacto técnico"): processos sintéticos
 * montados pelo MESMO `assembleEtpDraftContext` do gerador, cobrindo os casos que a story exige —
 * DFD aprovado com pesquisa concluída, DFD só em rascunho, ETP sem pesquisa de preços concluída e
 * orçamento sigiloso — com a guarda das decisões (RN-AI-35/36) na cadeia de pós-processamento.
 */

const BASE: EtpDraftSources = {
  process: {
    id: 'p-etp',
    code: '0012/2026',
    title: 'Computadores para os laboratórios das escolas',
    object: 'Aquisição de computadores para os laboratórios de informática',
    description: null,
    contractingType: 'Aquisição de bens',
    modality: 'Pregão eletrônico',
    isPriceRegistration: false,
    priority: 'HIGH',
    pcaStatus: 'PLANNED',
    pcaYear: 2026,
    pcaItemCode: 'PCA-2026-014',
    requestingSecretariat: 'Secretaria de Educação',
    requestingDepartment: 'Departamento de Tecnologia Educacional',
    isBudgetConfidential: false,
  },
  dfd: {
    documentId: 'd-dfd',
    documentTypeCode: 'DFD',
    source: 'APPROVED_VERSION',
    versionNumber: 2,
    draftRevision: null,
    sections: [
      {
        key: 'JUSTIFICATION',
        text: 'Os laboratórios operam com equipamentos obsoletos e sem suporte, prejudicando as aulas.',
      },
      {
        key: 'EXPECTED_RESULTS',
        text: 'Aulas de informática regulares e redução de custos de manutenção.',
      },
    ],
    header: {
      objectSummary: 'Computadores para os laboratórios',
      priority: 'HIGH',
      expectedDate: '2027-02-01',
      pcaStatus: 'PLANNED',
      pcaYear: 2026,
      pcaItemCode: 'PCA-2026-014',
    },
  },
  etp: {
    documentId: 'd-etp',
    documentTypeCode: 'ETP',
    draftRevision: 3,
    conclusion: 'PENDING',
    parcelingDecision: null,
    recommendedAlternativeId: null,
    estimatedTotalValue: null,
    estimatedValueSource: null,
  },
  items: [
    {
      processItemId: 'i-1',
      description: 'Computador desktop',
      unit: 'Unidade',
      quantity: '120.0000',
      calculationMemo: '12 escolas × 10 estações',
    },
  ],
  alternatives: [
    {
      id: 'a-1',
      name: 'Aquisição',
      description: 'Comprar os equipamentos com garantia de 36 meses',
      advantages: 'Patrimônio próprio',
      disadvantages: 'Investimento inicial maior',
      decision: 'UNDER_ANALYSIS',
      decisionJustification: null,
    },
    {
      id: 'a-2',
      name: 'Locação',
      description: 'Locar os equipamentos com manutenção inclusa',
      advantages: 'Manutenção inclusa',
      disadvantages: 'Custo recorrente',
      decision: 'UNDER_ANALYSIS',
      decisionJustification: null,
    },
  ],
  priceResearch: {
    id: 'r-1',
    code: 'PP 0003/2026',
    totalEstimatedValue: '125000.00',
    defaultMethod: 'AUTO_CV',
    items: [
      {
        processItemId: 'i-1',
        quantity: '120.0000',
        method: 'MEDIAN',
        validQuotationsCount: 4,
        unitPrice: '1041.67',
        totalPrice: '125000.00',
      },
    ],
  },
  template: null,
};

const CASES: readonly { id: string; label: string; sources: EtpDraftSources }[] = [
  { id: 'etp-01', label: 'DFD aprovado e pesquisa concluída', sources: BASE },
  {
    id: 'etp-02',
    label: 'DFD só em rascunho',
    sources: {
      ...BASE,
      dfd: { ...BASE.dfd, source: 'DRAFT', versionNumber: null, draftRevision: 7 },
    },
  },
  {
    id: 'etp-03',
    label: 'Sem pesquisa de preços concluída',
    sources: { ...BASE, priceResearch: null },
  },
  {
    id: 'etp-04',
    label: 'Orçamento sigiloso',
    sources: { ...BASE, process: { ...BASE.process, isBudgetConfidential: true } },
  },
];

export interface EvalSuite {
  readonly prompt: PromptTemplate;
  readonly sections: readonly SectionSpec[];
  readonly processes: readonly SyntheticProcess[];
}

/** Os processos sintéticos do ETP (todas as seções do modelo padrão). */
export function etpEvalSuite(): EvalSuite {
  const assembled = CASES.map((item) => ({
    ...item,
    context: assembleEtpDraftContext(item.sources),
  }));
  return {
    prompt: ETP_DRAFT_PROMPT,
    sections: assembled[0]?.context.sections ?? [],
    processes: assembled.map((item) => ({
      id: item.id,
      label: item.label,
      isBudgetConfidential: item.sources.process.isBudgetConfidential,
      needSummary: 'Renovar o parque de computadores dos laboratórios de informática das escolas.',
      parts: item.context.parts,
      postProcessors: item.context.postProcessors,
    })),
  };
}
