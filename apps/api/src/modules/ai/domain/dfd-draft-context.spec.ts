import { describe, expect, it } from 'vitest';

import { sanitizeContext } from './context-sanitizer.js';
import {
  DFD_DEFAULT_SECTIONS,
  assembleDfdDraftContext,
  dfdDraftRequestProblem,
  dfdDraftSections,
  formatCurrency,
  formatQuantity,
} from './dfd-draft-context.js';
import type { DfdDraftSources } from './dfd-draft-context.js';

/*
 * US-117 — `DfdDraftRequestPolicy` e `DfdDraftContextAssembler` (RN-AI-25..27): tamanhos e
 * documento do pedido, seções narrativas do template, `inputRefs`, sigilo do orçamento, lacunas e
 * minimização de dados pessoais.
 */

const PROCESS_ID = '0192d117-0000-7000-8000-000000000001';
const DOCUMENT_ID = '0192d117-0000-7000-8000-000000000002';
const TEMPLATE_VERSION_ID = '0192d117-0000-7000-8000-000000000003';
const ORG_ID = '0192d117-0000-7000-8000-000000000004';

function sources(overrides: Partial<DfdDraftSources> = {}): DfdDraftSources {
  return {
    process: {
      id: PROCESS_ID,
      code: '0012/2026',
      title: 'Computadores para as escolas',
      object: 'Aquisição de computadores para os laboratórios das escolas municipais',
      description: null,
      contractingType: 'Aquisição de bens',
      modality: null,
      origin: 'Demanda não prevista',
      isPriceRegistration: false,
      priority: 'HIGH',
      requestingSecretariat: 'Secretaria de Educação',
      requestingDepartment: 'Departamento de Tecnologia',
      targetDate: '2026-12-01',
      estimatedValue: '150000.00',
      isBudgetConfidential: false,
    },
    items: [
      { description: 'Computador desktop', unit: 'Unidade', quantity: '30.0000' },
      { description: 'Monitor 24 polegadas', unit: 'Unidade', quantity: '30.0000' },
      { description: 'Cabo de rede', unit: 'Metro', quantity: '120.5000' },
    ],
    dfd: {
      documentId: DOCUMENT_ID,
      documentTypeCode: 'DFD',
      draftRevision: 4,
      objectSummary: 'Computadores para os laboratórios',
      priority: 'HIGH',
      requestDate: '2026-10-18',
      expectedDate: '2026-12-01',
      estimatedValue: '150000.00',
      pcaStatus: 'PLANNED',
      pcaYear: 2026,
      pcaItemCode: 'PCA-2026-015',
    },
    organization: {
      id: ORG_ID,
      name: 'Prefeitura de São José',
      type: 'DIRECT_ADMINISTRATION',
      city: 'São José',
      state: 'SC',
    },
    template: {
      versionId: TEMPLATE_VERSION_ID,
      versionNumber: 2,
      sections: [
        ...DFD_DEFAULT_SECTIONS.map((section) => ({
          ...section,
          helpText: `Orientação de ${section.key}`,
        })),
        {
          key: 'ITEMS_TABLE',
          title: 'Itens',
          requirement: 'OPTIONAL',
          helpText: null,
          legalBasis: null,
          defaultText: null,
          maxChars: 1_000,
          allowNarrative: false,
        },
      ],
    },
    ...overrides,
  };
}

const partOf = (context: ReturnType<typeof assembleDfdDraftContext>, kind: string) =>
  context.parts.find((part) => part.ref.kind === kind);

describe('DfdDraftRequestPolicy (RN-AI-25 · V-01/V-02)', () => {
  it.each([
    [{ needSummary: 'x'.repeat(20), documentId: DOCUMENT_ID }, null],
    [{ needSummary: 'x'.repeat(2_000), documentId: DOCUMENT_ID }, null],
    [{ needSummary: 'x'.repeat(19), documentId: DOCUMENT_ID }, 'NEED_SUMMARY_LENGTH'],
    [{ needSummary: 'x'.repeat(2_001), documentId: DOCUMENT_ID }, 'NEED_SUMMARY_LENGTH'],
    [{ needSummary: null, documentId: DOCUMENT_ID }, 'NEED_SUMMARY_REQUIRED'],
    [{ needSummary: 'x'.repeat(30), documentId: null }, 'DOCUMENT_REQUIRED'],
  ] as const)('%o → %s', (request, expected) => {
    expect(dfdDraftRequestProblem(request)).toBe(expected);
  });
});

describe('DfdDraftContextAssembler (RN-AI-25/26)', () => {
  it('cobre só as seções narrativas do template; a opcional pode vir ausente (FA-08)', () => {
    const context = assembleDfdDraftContext(sources());
    expect(context.sections.map((section) => section.sectionKey)).toEqual([
      'JUSTIFICATION',
      'EXPECTED_RESULTS',
      'NOTES',
    ]);
    expect(context.sections.find((s) => s.sectionKey === 'NOTES')?.optional).toBe(true);
    expect(
      context.sections.find((s) => s.sectionKey === 'JUSTIFICATION')?.optional,
    ).toBeUndefined();
  });

  it('sem template fixado usa as seções padrão do DFD', () => {
    expect(dfdDraftSections(DFD_DEFAULT_SECTIONS)).toHaveLength(3);
    const context = assembleDfdDraftContext(sources({ template: null }));
    expect(context.sections).toHaveLength(3);
    expect(partOf(context, 'TEMPLATE_VERSION')?.ref.id).toBeNull();
  });

  it('cada fonte vira um inputRef: processo, catálogo, cabeçalho, itens, órgão e template', () => {
    const context = assembleDfdDraftContext(sources());
    expect(context.parts.map((part) => part.ref)).toEqual([
      { kind: 'PROCESS', id: PROCESS_ID },
      { kind: 'CATALOG', id: null },
      { kind: 'DOCUMENT_DRAFT', id: DOCUMENT_ID, documentTypeCode: 'DFD', revision: 4 },
      { kind: 'PROCESS_ITEMS', id: PROCESS_ID },
      { kind: 'ORGANIZATION', id: ORG_ID },
      { kind: 'TEMPLATE_VERSION', id: TEMPLATE_VERSION_ID, versionNumber: 2 },
    ]);
    expect(context.warnings).toEqual([]);
    expect(context.isBudgetConfidential).toBe(false);
  });

  it('itens com descrição, unidade e quantidade; valores e datas formatados em pt-BR', () => {
    const context = assembleDfdDraftContext(sources());
    expect(partOf(context, 'PROCESS_ITEMS')?.data).toEqual([
      { descricao: 'Computador desktop', unidade: 'Unidade', quantidade: '30' },
      { descricao: 'Monitor 24 polegadas', unidade: 'Unidade', quantidade: '30' },
      { descricao: 'Cabo de rede', unidade: 'Metro', quantidade: '120,5' },
    ]);
    expect(partOf(context, 'DOCUMENT_DRAFT')?.data).toMatchObject({
      dataPrevistaDaContratacao: '01/12/2026',
      valorEstimado: 'R$ 150.000,00',
      anoDoPca: '2026',
      itemDoPca: 'PCA-2026-015',
    });
    expect(partOf(context, 'TEMPLATE_VERSION')?.data).toEqual([
      expect.objectContaining({
        secao: 'JUSTIFICATION',
        orientacao: 'Orientação de JUSTIFICATION',
      }),
      expect.objectContaining({ secao: 'EXPECTED_RESULTS' }),
      expect.objectContaining({ secao: 'NOTES', obrigatoria: 'Não' }),
    ]);
  });

  it('orçamento sigiloso: nenhum valor no contexto e o aviso BUDGET_CONFIDENTIAL_VALUES_OMITTED', () => {
    const base = sources();
    const context = assembleDfdDraftContext({
      ...base,
      process: { ...base.process, isBudgetConfidential: true },
    });
    const serialized = JSON.stringify(context.parts);
    expect(serialized).not.toContain('150.000');
    expect(serialized).not.toContain('valorEstimado');
    expect(context.isBudgetConfidential).toBe(true);
    expect(context.warnings).toContainEqual({ code: 'BUDGET_CONFIDENTIAL_VALUES_OMITTED' });
  });

  it('entradas incompletas: sem itens, sem data prevista e sem vínculo do PCA → MISSING_OPTIONAL_INPUT (FA-07)', () => {
    const base = sources();
    const context = assembleDfdDraftContext({
      ...base,
      items: [],
      dfd: { ...base.dfd, expectedDate: null, pcaItemCode: null },
    });
    expect(context.warnings).toEqual([
      { code: 'MISSING_OPTIONAL_INPUT', params: { input: 'ITEMS' } },
      { code: 'MISSING_OPTIONAL_INPUT', params: { input: 'EXPECTED_DATE' } },
      { code: 'MISSING_OPTIONAL_INPUT', params: { input: 'PCA_LINK' } },
    ]);
    expect(partOf(context, 'PROCESS_ITEMS')?.data).toEqual([]);
  });

  it('sem pessoas nem contatos: a sanitização não encontra chave pessoal para remover', () => {
    const context = assembleDfdDraftContext(sources());
    const sanitized = sanitizeContext(context.parts, {
      isBudgetConfidential: false,
      maxChars: 240_000,
    });
    expect(sanitized.stats.removedKeys).toBe(0);
    expect(sanitized.inputRefs).toHaveLength(6);
    // Tipo do órgão por rótulo; município/UF sim, endereço e contatos não existem na fonte.
    expect(partOf(context, 'ORGANIZATION')?.data).toEqual({
      nome: 'Prefeitura de São José',
      tipo: 'Administração direta',
      municipio: 'São José',
      uf: 'SC',
    });
  });

  it('os itens são parte opcional: cortados antes de faltar espaço (CONTEXT_TRUNCATED)', () => {
    expect(partOf(assembleDfdDraftContext(sources()), 'PROCESS_ITEMS')?.optional).toBe(true);
  });
});

describe('formatação', () => {
  it.each([
    ['120.0000', '120'],
    ['2.5000', '2,5'],
    ['0.1250', '0,125'],
  ])('quantidade %s → %s', (value, expected) => {
    expect(formatQuantity(value)).toBe(expected);
  });

  it.each([
    ['15000.00', 'R$ 15.000,00'],
    ['999.5', 'R$ 999,50'],
    ['1234567.89', 'R$ 1.234.567,89'],
  ])('valor %s → %s', (value, expected) => {
    expect(formatCurrency(value)).toBe(expected);
  });
});
