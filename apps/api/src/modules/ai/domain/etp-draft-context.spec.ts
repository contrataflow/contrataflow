import type { AiGenerationOutput, RichTextNode } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { sanitizeContext } from './context-sanitizer.js';
import {
  CONCLUSION_PENDING,
  ETP_DEFAULT_SECTIONS,
  PARCELING_PENDING,
  SOLUTION_PENDING,
  VALUE_OMITTED,
  VALUE_PENDING,
  assembleEtpDraftContext,
  etpDraftSections,
  etpPendingMarks,
  withoutMoney,
} from './etp-draft-context.js';
import type { EtpDraftSources, EtpTemplateSection } from './etp-draft-context.js';
import { FactSet, findFacts } from './fact-set.js';
import { GroundingGuard } from './grounding-guard.js';
import { countToConfirm, toConfirmNode } from './output-converter.js';

/*
 * US-118 — `EtpDraftContext` e `EtpDecisionGuard` (RN-AI-33..37): precedência do DFD nos
 * `inputRefs`, entradas do ETP, valor estimado só da pesquisa concluída, sigilo do orçamento (nem em
 * texto livre), seções de renderização estruturada e as marcações das decisões que ficam com a
 * pessoa.
 */

const PROCESS_ID = '0192d118-0000-7000-8000-000000000001';
const DFD_ID = '0192d118-0000-7000-8000-000000000002';
const ETP_ID = '0192d118-0000-7000-8000-000000000003';
const RESEARCH_ID = '0192d118-0000-7000-8000-000000000004';
const TEMPLATE_VERSION_ID = '0192d118-0000-7000-8000-000000000005';
const ITEM_ID = '0192d118-0000-7000-8000-000000000006';

function sources(overrides: Partial<EtpDraftSources> = {}): EtpDraftSources {
  return {
    process: {
      id: PROCESS_ID,
      code: '0012/2026',
      title: 'Computadores para as escolas',
      object: 'Aquisição de computadores para os laboratórios',
      description: null,
      contractingType: 'Aquisição de bens',
      modality: null,
      isPriceRegistration: false,
      priority: 'HIGH',
      pcaStatus: 'PLANNED',
      pcaYear: 2026,
      pcaItemCode: 'PCA-2026-015',
      requestingSecretariat: 'Secretaria de Educação',
      requestingDepartment: 'Departamento de Tecnologia',
      isBudgetConfidential: false,
    },
    dfd: {
      documentId: DFD_ID,
      documentTypeCode: 'DFD',
      source: 'APPROVED_VERSION',
      versionNumber: 2,
      draftRevision: null,
      sections: [{ key: 'JUSTIFICATION', text: 'Equipamentos obsoletos prejudicam as aulas.' }],
      header: {
        objectSummary: 'Computadores para os laboratórios',
        priority: 'HIGH',
        expectedDate: '2027-02-01',
        pcaStatus: 'PLANNED',
        pcaYear: 2026,
        pcaItemCode: 'PCA-2026-015',
      },
    },
    etp: {
      documentId: ETP_ID,
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
        processItemId: ITEM_ID,
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
        description: 'Comprar os equipamentos',
        advantages: 'Patrimônio próprio',
        disadvantages: null,
        decision: 'UNDER_ANALYSIS',
        decisionJustification: null,
      },
    ],
    priceResearch: {
      id: RESEARCH_ID,
      code: 'PP 0003/2026',
      totalEstimatedValue: '125000.00',
      defaultMethod: 'AUTO_CV',
      items: [
        {
          processItemId: ITEM_ID,
          quantity: '120.0000',
          method: 'MEDIAN',
          validQuotationsCount: 4,
          unitPrice: '1041.67',
          totalPrice: '125000.00',
        },
      ],
    },
    template: null,
    ...overrides,
  };
}

const sanitized = (input: EtpDraftSources) => {
  const context = assembleEtpDraftContext(input);
  return sanitizeContext(context.parts, {
    isBudgetConfidential: context.isBudgetConfidential,
    maxChars: 240_000,
  });
};

const paragraph = (text: string): RichTextNode => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

function output(keys: readonly string[], nodes: RichTextNode[] = [paragraph('Texto.')]) {
  return {
    sections: keys.map((sectionKey) => ({
      sectionKey,
      title: sectionKey,
      content: { type: 'doc', content: [...nodes] },
      placeholdersCount: 0,
      groundingReplacements: 0,
    })),
    warnings: [],
  } as unknown as AiGenerationOutput;
}

const labelsOf = (result: AiGenerationOutput, key: string) => {
  const labels: string[] = [];
  const walk = (nodes: readonly RichTextNode[] | undefined) => {
    for (const node of nodes ?? []) {
      if (node.type === 'toConfirm') labels.push(String(node.attrs?.label));
      walk(node.content);
    }
  };
  walk(
    (result.sections.find((section) => section.sectionKey === key)?.content as RichTextNode)
      .content,
  );
  return labels;
};

describe('EtpDraftContext (US-118 · RN-AI-33/34)', () => {
  it('DFD aprovado: DOCUMENT_VERSION com a versão; itens, alternativas, pesquisa e template viram inputRefs', () => {
    const context = assembleEtpDraftContext(sources());
    expect(context.parts.map((part) => part.ref)).toEqual([
      { kind: 'PROCESS', id: PROCESS_ID },
      { kind: 'CATALOG', id: null },
      { kind: 'DOCUMENT_VERSION', id: DFD_ID, documentTypeCode: 'DFD', versionNumber: 2 },
      { kind: 'DOCUMENT_DRAFT', id: ETP_ID, documentTypeCode: 'ETP', revision: 3 },
      { kind: 'PROCESS_ITEMS', id: ETP_ID },
      { kind: 'ETP_ALTERNATIVES', id: ETP_ID },
      { kind: 'PRICE_RESEARCH', id: RESEARCH_ID },
      { kind: 'TEMPLATE_VERSION', id: null },
    ]);
    expect(context.warnings).toEqual([]);
    const sent = JSON.stringify(context.parts);
    expect(sent).toContain('12 escolas × 10 estações');
    expect(sent).toContain('R$ 125.000,00');
    expect(sent).toContain('Mediana');
    expect(sent).toContain('"cotacoesValidas":"4"');
    expect(context.sections.map((section) => section.sectionKey)).toEqual(
      ETP_DEFAULT_SECTIONS.map((section) => section.key),
    );
  });

  it('DFD só em rascunho (FA-02): DOCUMENT_DRAFT com a revisão e USED_DRAFT_INPUTS', () => {
    const context = assembleEtpDraftContext(
      sources({
        dfd: { ...sources().dfd, source: 'DRAFT', versionNumber: null, draftRevision: 7 },
      }),
    );
    expect(context.parts[2]?.ref).toEqual({
      kind: 'DOCUMENT_DRAFT',
      id: DFD_ID,
      documentTypeCode: 'DFD',
      revision: 7,
    });
    expect(context.warnings).toContainEqual({
      code: 'USED_DRAFT_INPUTS',
      params: { input: 'DFD' },
    });
  });

  it('sem pesquisa concluída (FA-03): MISSING_PRICE_RESEARCH, sem a parte da pesquisa; valor vinculado do ETP vale', () => {
    const context = assembleEtpDraftContext(sources({ priceResearch: null }));
    expect(context.warnings).toContainEqual({ code: 'MISSING_PRICE_RESEARCH' });
    expect(context.parts.some((part) => part.ref.kind === 'PRICE_RESEARCH')).toBe(false);
    expect(JSON.stringify(context.parts)).not.toContain('R$');

    const linked = assembleEtpDraftContext(
      sources({
        priceResearch: null,
        etp: {
          ...sources().etp,
          estimatedTotalValue: '98000.00',
          estimatedValueSource: 'PRICE_RESEARCH',
        },
      }),
    );
    expect(JSON.stringify(linked.parts)).toContain('R$ 98.000,00');
    // Valor manual nunca vale como estimativa (RN-AI-36).
    const manual = assembleEtpDraftContext(
      sources({
        priceResearch: null,
        etp: { ...sources().etp, estimatedTotalValue: '98000.00', estimatedValueSource: 'MANUAL' },
      }),
    );
    expect(JSON.stringify(manual.parts)).not.toContain('98');
  });

  it('orçamento sigiloso (DEC-030): nenhum valor monetário no contexto, nem em texto livre', () => {
    const input = sources({
      process: { ...sources().process, isBudgetConfidential: true },
      dfd: {
        ...sources().dfd,
        sections: [{ key: 'JUSTIFICATION', text: 'Gasto anual de R$ 80.000,00 com manutenção.' }],
      },
      items: sources().items.map((item) => ({ ...item, calculationMemo: '120 × R$ 1.041,67' })),
    });
    const context = assembleEtpDraftContext(input);
    expect(context.warnings).toContainEqual({ code: 'BUDGET_CONFIDENTIAL_VALUES_OMITTED' });
    const sent = JSON.stringify(sanitized(input).parts);
    expect(sent).not.toContain('R$');
    expect(sent).not.toContain('125.000');
    expect(sent).not.toContain('80.000');
    expect(sent).toContain(VALUE_OMITTED);
    // O método e as cotações válidas continuam (não são valores).
    expect(sent).toContain('Mediana');
  });

  it('lacunas opcionais: sem itens nem alternativas → MISSING_OPTIONAL_INPUT', () => {
    const context = assembleEtpDraftContext(sources({ items: [], alternatives: [] }));
    expect(context.warnings).toEqual(
      expect.arrayContaining([
        { code: 'MISSING_OPTIONAL_INPUT', params: { input: 'ETP_ITEMS' } },
        { code: 'MISSING_OPTIONAL_INPUT', params: { input: 'ALTERNATIVES' } },
      ]),
    );
  });

  it('alternativas: nome, textos e decisão; sem custo informado', () => {
    const sent = JSON.stringify(assembleEtpDraftContext(sources()).parts);
    expect(sent).toContain('"nome":"Aquisição"');
    expect(sent).toContain('Em análise');
    expect(sent).not.toContain('custo');
  });
});

describe('Seções do ETP (RN-AI-37)', () => {
  const section = (key: string, extra: Partial<EtpTemplateSection> = {}): EtpTemplateSection => ({
    key,
    title: key,
    requirement: 'REQUIRED',
    helpText: null,
    legalBasis: null,
    defaultText: null,
    maxChars: 5_000,
    render: 'TEXT',
    allowNarrative: true,
    ...extra,
  });

  it('estruturada com narrativa entra como complemento; sem narrativa fica fora da proposta', () => {
    const sections = [
      section('NEED_DESCRIPTION'),
      section('ITEMS', { render: 'ITEMS_TABLE' }),
      section('VALUE', { render: 'ESTIMATED_VALUE', allowNarrative: false }),
      section('PROBLEM', { requirement: 'OPTIONAL' }),
    ];
    expect(etpDraftSections(sections)).toEqual([
      {
        sectionKey: 'NEED_DESCRIPTION',
        title: 'NEED_DESCRIPTION',
        maxChars: 5_000,
        legalBasis: null,
      },
      { sectionKey: 'ITEMS', title: 'ITEMS', maxChars: 5_000, legalBasis: null },
      {
        sectionKey: 'PROBLEM',
        title: 'PROBLEM',
        maxChars: 5_000,
        legalBasis: null,
        optional: true,
      },
    ]);
    const context = assembleEtpDraftContext(
      sources({
        template: { versionId: TEMPLATE_VERSION_ID, versionNumber: 4, sections },
      }),
    );
    const guide = context.parts.at(-1);
    expect(guide?.ref).toEqual({
      kind: 'TEMPLATE_VERSION',
      id: TEMPLATE_VERSION_ID,
      versionNumber: 4,
    });
    const rows = guide?.data as { secao: string; tratamento?: string }[];
    expect(rows.map((row) => row.secao)).toEqual(['NEED_DESCRIPTION', 'ITEMS', 'PROBLEM']);
    expect(rows.find((row) => row.secao === 'ITEMS')?.tratamento).toContain('Texto complementar');
    expect(rows.find((row) => row.secao === 'NEED_DESCRIPTION')?.tratamento).toBeUndefined();
  });
});

describe('EtpDecisionGuard (RN-AI-35/36 — a IA não decide)', () => {
  it('marcas pelas decisões pendentes e pelo valor ausente; nenhuma com tudo decidido', () => {
    expect(
      etpPendingMarks({
        conclusion: 'PENDING',
        hasRecommendedAlternative: false,
        parcelingDecision: null,
        hasGroundedValue: false,
      }).map((mark) => [mark.sectionKey, mark.category]),
    ).toEqual([
      ['CONCLUSION', 'DECISION'],
      ['RECOMMENDED_SOLUTION', 'DECISION'],
      ['PARCELING', 'DECISION'],
      ['ESTIMATES', 'VALUE'],
    ]);
    expect(
      etpPendingMarks({
        conclusion: 'VIABLE',
        hasRecommendedAlternative: true,
        parcelingDecision: 'NOT_PARCELED',
        hasGroundedValue: true,
      }),
    ).toEqual([]);
  });

  it('acrescenta a marcação que faltar, não duplica a existente e é idempotente', () => {
    const context = assembleEtpDraftContext(sources({ priceResearch: null }));
    const [guard] = context.postProcessors;
    if (guard === undefined) throw new Error('sem guarda');
    const keys = ['CONCLUSION', 'RECOMMENDED_SOLUTION', 'PARCELING', 'ESTIMATES', 'OBJECTIVE'];
    const raw = output(keys);
    // A conclusão já traz a marcação (vinda do provedor): não repete.
    const conclusion = raw.sections.find((section) => section.sectionKey === 'CONCLUSION');
    (conclusion?.content as { content: RichTextNode[] }).content.push({
      type: 'paragraph',
      content: [toConfirmNode(CONCLUSION_PENDING, 'DECISION')],
    });
    const first = guard.process({ output: raw, context: sanitized(sources()) });
    expect(labelsOf(first, 'CONCLUSION')).toEqual([CONCLUSION_PENDING]);
    expect(labelsOf(first, 'RECOMMENDED_SOLUTION')).toEqual([SOLUTION_PENDING]);
    expect(labelsOf(first, 'PARCELING')).toEqual([PARCELING_PENDING]);
    expect(labelsOf(first, 'ESTIMATES')).toEqual([VALUE_PENDING]);
    expect(labelsOf(first, 'OBJECTIVE')).toEqual([]);
    const again = guard.process({ output: first, context: sanitized(sources()) });
    expect(again).toEqual(first);
    const estimates = first.sections.find((section) => section.sectionKey === 'ESTIMATES');
    expect(countToConfirm(estimates?.content as { content: RichTextNode[] })).toBe(1);
  });

  it('com a pesquisa concluída não marca o valor; com sigilo marca (o valor não pode aparecer)', () => {
    const marked = (input: EtpDraftSources) => {
      const [guard] = assembleEtpDraftContext(input).postProcessors;
      if (guard === undefined) throw new Error('sem guarda');
      return labelsOf(
        guard.process({ output: output(['ESTIMATES']), context: sanitized(input) }),
        'ESTIMATES',
      );
    };
    expect(marked(sources())).toEqual([]);
    expect(
      marked(sources({ process: { ...sources().process, isBudgetConfidential: true } })),
    ).toEqual([VALUE_PENDING]);
  });

  it('GroundingGuard sobre o mesmo contexto: valor inventado vira [a confirmar]; o da pesquisa fica', () => {
    const input = sources();
    const context = sanitized(input);
    const result = new GroundingGuard().process({
      output: output(['ESTIMATES'], [paragraph('Estimado em R$ 125.000,00, não R$ 99.999,00.')]),
      context,
    });
    const text = JSON.stringify(result.sections[0]?.content);
    expect(text).toContain('R$ 125.000,00');
    expect(text).not.toContain('99.999');
    expect(result.sections[0]?.groundingReplacements).toBe(1);
    expect(FactSet.fromContext(context).size).toBeGreaterThan(0);
  });

  it('withoutMoney troca só os valores monetários', () => {
    const text = withoutMoney('São 120 unidades a R$ 1.041,67 cada, total de 125 mil reais.');
    expect(text).toBe(`São 120 unidades a ${VALUE_OMITTED} cada, total de ${VALUE_OMITTED}.`);
    expect(findFacts(text).some((match) => match.kind === 'MONEY')).toBe(false);
  });
});
