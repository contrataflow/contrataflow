import { assembleTermDraftContext } from '#modules/ai/domain/term-draft-context.js';
import type { TermDraftSources } from '#modules/ai/domain/term-draft-context.js';
import { TERM_DRAFT_PROMPT } from '#modules/ai/prompts/draft.tr/prompt.js';

import type { EvalSuite } from './ai-eval-etp.js';

/*
 * Suíte `draft.tr` do `pnpm ai:eval --suite tr` (US-120 · "Impacto técnico"): processos sintéticos
 * montados pelo MESMO `assembleTermDraftContext` do gerador, cobrindo os casos que a story exige —
 * TR com as condições preenchidas, TR sem condições preenchidas, sem pesquisa de preços concluída e
 * com seções importadas do ETP (o ETP ainda em rascunho) — com a guarda das condições (RN-AI-44/46)
 * na cadeia de pós-processamento.
 */

const BASE: TermDraftSources = {
  process: {
    id: 'p-tr',
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
  etp: {
    documentId: 'd-etp',
    documentTypeCode: 'ETP',
    source: 'APPROVED_VERSION',
    versionNumber: 2,
    draftRevision: null,
    sections: [
      {
        key: 'NEED_DESCRIPTION',
        text: 'Os laboratórios operam com equipamentos obsoletos e sem suporte, prejudicando as aulas.',
      },
      {
        key: 'RECOMMENDED_SOLUTION',
        text: 'Aquisição de 120 computadores desktop com garantia on-site.',
      },
    ],
    estimatedTotalValue: '125000.00',
    estimatedValueSource: 'PRICE_RESEARCH',
  },
  dfd: null,
  risks: [
    {
      title: 'Atraso na entrega dos equipamentos',
      description: 'Fornecedor sem estoque para a quantidade contratada',
      category: 'Prazo',
      phase: 'CONTRACT_MANAGEMENT',
      treatments: ['Exigir cronograma de entrega na proposta'],
    },
  ],
  term: {
    documentId: 'd-tr',
    documentTypeCode: 'TR',
    draftRevision: 4,
    conditions: {
      contractDurationMonths: 12,
      executionDeadline: 30,
      executionDeadlineType: 'CALENDAR',
      deliveryLocation: 'Almoxarifado central da Secretaria de Educação',
      paymentTermDays: 30,
      productWarrantyMonths: 36,
      contractGuaranteePercent: '5',
      allowsSubcontracting: false,
      selectionCriterion: 'Menor preço',
      awardType: 'BY_ITEM',
    },
    estimatedTotalValue: '125000.00',
    estimatedValueSource: 'PRICE_RESEARCH',
  },
  items: [
    {
      processItemId: 'i-1',
      description: 'Computador desktop',
      unit: 'Unidade',
      quantity: '120.0000',
      specification: 'Processador de 8 núcleos, 16 GB de memória e SSD de 512 GB.',
      acceptanceCriteria: 'Teste de inicialização e conferência do número de série.',
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

const CASES: readonly { id: string; label: string; sources: TermDraftSources }[] = [
  { id: 'tr-01', label: 'Condições preenchidas e pesquisa concluída', sources: BASE },
  {
    id: 'tr-02',
    label: 'TR sem condições preenchidas',
    sources: {
      ...BASE,
      term: {
        ...BASE.term,
        conditions: {
          contractDurationMonths: null,
          executionDeadline: null,
          executionDeadlineType: null,
          deliveryLocation: null,
          paymentTermDays: null,
          productWarrantyMonths: null,
          contractGuaranteePercent: null,
          allowsSubcontracting: null,
          selectionCriterion: null,
          awardType: null,
        },
      },
    },
  },
  {
    id: 'tr-03',
    label: 'Sem pesquisa de preços concluída',
    sources: {
      ...BASE,
      priceResearch: null,
      term: { ...BASE.term, estimatedTotalValue: null, estimatedValueSource: null },
    },
  },
  {
    id: 'tr-04',
    label: 'Seções importadas do ETP em rascunho',
    sources: {
      ...BASE,
      etp: { ...BASE.etp, source: 'DRAFT', versionNumber: null, draftRevision: 9 },
      term: { ...BASE.term, estimatedValueSource: 'ETP' },
    },
  },
];

/** Os processos sintéticos do TR (todas as seções do modelo padrão). */
export function termEvalSuite(): EvalSuite {
  const assembled = CASES.map((item) => ({
    ...item,
    context: assembleTermDraftContext(item.sources),
  }));
  return {
    prompt: TERM_DRAFT_PROMPT,
    sections: assembled[0]?.context.sections ?? [],
    processes: assembled.map((item) => ({
      id: item.id,
      label: item.label,
      isBudgetConfidential: item.sources.process.isBudgetConfidential,
      needSummary: '',
      parts: item.context.parts,
      postProcessors: item.context.postProcessors,
    })),
  };
}
