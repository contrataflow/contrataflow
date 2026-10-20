import type { AiGenerationOutput, RichTextNode } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { sanitizeContext } from './context-sanitizer.js';
import { GroundingGuard } from './grounding-guard.js';
import { countToConfirm, toConfirmNode } from './output-converter.js';
import {
  BUDGET_PENDING,
  CRITERION_PENDING,
  DURATION_PENDING,
  EXECUTION_PENDING,
  GUARANTEE_PENDING,
  LOCATION_PENDING,
  PAYMENT_PENDING,
  SUBCONTRACTING_PENDING,
  TERM_DEFAULT_SECTIONS,
  VALUE_PENDING,
  WARRANTY_PENDING,
  assembleTermDraftContext,
  termPendingMarks,
} from './term-draft-context.js';
import type { TermDraftConditions, TermDraftSources } from './term-draft-context.js';

/*
 * US-120 — `TermDraftContext` e `TermConditionGuard` (RN-AI-43..46): o ETP pela precedência nos
 * `inputRefs`, DFD e riscos opcionais (sem pessoas), condições tipadas como única fonte de prazos,
 * pagamento e garantias, valor estimado só da pesquisa concluída (ou do vínculo), sigilo do
 * orçamento e as marcações das condições ausentes; o GroundingGuard sobre o mesmo contexto troca a
 * multa inventada e preserva as citações legais.
 */

const PROCESS_ID = '0192d120-0000-7000-8000-000000000001';
const ETP_ID = '0192d120-0000-7000-8000-000000000002';
const TERM_ID = '0192d120-0000-7000-8000-000000000003';
const RESEARCH_ID = '0192d120-0000-7000-8000-000000000004';
const DFD_ID = '0192d120-0000-7000-8000-000000000005';
const ITEM_ID = '0192d120-0000-7000-8000-000000000006';

const FILLED: TermDraftConditions = {
  contractDurationMonths: 12,
  executionDeadline: 15,
  executionDeadlineType: 'BUSINESS',
  deliveryLocation: 'Almoxarifado central, Rua das Flores, 100',
  paymentTermDays: 30,
  productWarrantyMonths: 24,
  contractGuaranteePercent: '5',
  allowsSubcontracting: false,
  selectionCriterion: 'Menor preço',
  awardType: 'BY_ITEM',
};

const EMPTY: TermDraftConditions = {
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
};

function sources(overrides: Partial<TermDraftSources> = {}): TermDraftSources {
  return {
    process: {
      id: PROCESS_ID,
      code: '0012/2026',
      title: 'Computadores para os laboratórios',
      object: 'Aquisição de computadores para os laboratórios de informática',
      description: null,
      contractingType: 'Aquisição de bens',
      modality: null,
      isPriceRegistration: false,
      priority: 'HIGH',
      pcaStatus: 'PLANNED',
      pcaYear: 2026,
      pcaItemCode: 'PCA-2026-014',
      requestingSecretariat: 'Secretaria de Educação',
      requestingDepartment: 'Setor de Tecnologia',
      isBudgetConfidential: false,
    },
    etp: {
      documentId: ETP_ID,
      documentTypeCode: 'ETP',
      source: 'VERSION',
      versionNumber: 2,
      draftRevision: null,
      sections: [{ key: 'NEED_DESCRIPTION', text: 'Equipamentos obsoletos nos laboratórios.' }],
      estimatedTotalValue: '125000.00',
      estimatedValueSource: 'PRICE_RESEARCH',
    },
    dfd: {
      documentId: DFD_ID,
      documentTypeCode: 'DFD',
      source: 'APPROVED_VERSION',
      versionNumber: 1,
      draftRevision: null,
      sections: [{ key: 'JUSTIFICATION', text: 'As aulas de informática estão suspensas.' }],
    },
    risks: [
      {
        title: 'Atraso na entrega',
        description: 'Fornecedor sem estoque',
        category: 'Operacional',
        phase: 'CONTRACT_MANAGEMENT',
        treatments: ['Exigir cronograma de entrega'],
      },
    ],
    term: {
      documentId: TERM_ID,
      documentTypeCode: 'TR',
      draftRevision: 3,
      conditions: { ...EMPTY, contractDurationMonths: 12, paymentTermDays: 30 },
      estimatedTotalValue: '125000.00',
      estimatedValueSource: 'PRICE_RESEARCH',
    },
    items: [
      {
        processItemId: ITEM_ID,
        description: 'Computador desktop',
        unit: 'Unidade',
        quantity: '120.0000',
        specification: 'Processador de 8 núcleos e 16 GB de memória.',
        acceptanceCriteria: 'Teste de inicialização em todas as unidades.',
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

const sanitized = (input: TermDraftSources) => {
  const context = assembleTermDraftContext(input);
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
      content: { type: 'doc', content: structuredClone(nodes) },
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

const guarded = (input: TermDraftSources, keys: readonly string[], nodes?: RichTextNode[]) => {
  const [guard] = assembleTermDraftContext(input).postProcessors;
  if (guard === undefined) throw new Error('sem guarda');
  return guard.process({ output: output(keys, nodes), context: sanitized(input) });
};

describe('TermDraftContext (US-120 · RN-AI-43)', () => {
  it('ETP finalizado, DFD, riscos, condições, itens, pesquisa e template viram inputRefs', () => {
    const context = sanitized(sources());
    expect(context.inputRefs.map((ref) => ref.kind)).toEqual([
      'PROCESS',
      'CATALOG',
      'DOCUMENT_VERSION',
      'TERM_CONDITIONS',
      'PROCESS_ITEMS',
      'DOCUMENT_VERSION',
      'RISKS',
      'PRICE_RESEARCH',
      'TEMPLATE_VERSION',
    ]);
    expect(context.inputRefs[2]).toMatchObject({
      id: ETP_ID,
      documentTypeCode: 'ETP',
      versionNumber: 2,
    });
    expect(context.inputRefs[5]).toMatchObject({ id: DFD_ID, documentTypeCode: 'DFD' });
    expect(assembleTermDraftContext(sources()).warnings).toEqual([]);
    const sent = JSON.stringify(context.parts);
    expect(sent).toContain('Processador de 8 núcleos');
    expect(sent).toContain('Teste de inicialização');
    expect(sent).toContain('Exigir cronograma de entrega');
    expect(sent).toContain('R$ 125.000,00');
  });

  it('ETP só em rascunho, sem DFD, riscos nem itens: USED_DRAFT_INPUTS e MISSING_OPTIONAL_INPUT', () => {
    const input = sources({
      etp: { ...sources().etp, source: 'DRAFT', versionNumber: null, draftRevision: 7 },
      dfd: null,
      risks: [],
      items: [],
    });
    expect(assembleTermDraftContext(input).warnings).toEqual([
      { code: 'USED_DRAFT_INPUTS', params: { input: 'ETP' } },
      { code: 'MISSING_OPTIONAL_INPUT', params: { input: 'DFD' } },
      { code: 'MISSING_OPTIONAL_INPUT', params: { input: 'RISKS' } },
      { code: 'MISSING_OPTIONAL_INPUT', params: { input: 'TERM_ITEMS' } },
    ]);
    expect(sanitized(input).inputRefs[2]).toMatchObject({ kind: 'DOCUMENT_DRAFT', revision: 7 });
    const { dfd } = sources();
    if (!dfd) throw new Error('fixture sem DFD');
    const dfdDraft = sources({ dfd: { ...dfd, source: 'DRAFT', draftRevision: 2 } });
    expect(assembleTermDraftContext(dfdDraft).warnings).toEqual([
      { code: 'USED_DRAFT_INPUTS', params: { input: 'DFD' } },
    ]);
  });

  it('condições tipadas como texto ("12 meses", "30 dias", "5%") e as ausentes listadas como [a confirmar]', () => {
    const sent = JSON.stringify(sanitized(sources()).parts);
    expect(sent).toContain('12 meses');
    expect(sent).toContain('30 dias');
    expect(sent).toContain(`[a confirmar: ${LOCATION_PENDING}]`);
    const full = JSON.stringify(
      sanitized(sources({ term: { ...sources().term, conditions: FILLED } })).parts,
    );
    expect(full).toContain('15 dias úteis');
    expect(full).toContain('24 meses');
    expect(full).toContain('5% do valor do contrato');
    expect(full).toContain('Almoxarifado central');
    expect(full).toContain('Não permitida');
    expect(full).toContain('Menor preço');
    expect(full).toContain('Por item');
    expect(full).not.toContain('[a confirmar');
  });

  it('riscos sem responsáveis nem prazos: só título, descrição, categoria, fase e tratamentos', () => {
    const [risk] = (sanitized(sources()).parts.find((part) => part.ref.kind === 'RISKS')?.data ??
      []) as Record<string, unknown>[];
    expect(Object.keys(risk ?? {}).sort()).toEqual(
      ['categoria', 'descricao', 'fase', 'tratamentos', 'titulo'].sort(),
    );
  });

  it('RN-AI-46: sem pesquisa concluída, MISSING_PRICE_RESEARCH; vínculo do TR vale, valor manual nunca', () => {
    const linked = assembleTermDraftContext(sources({ priceResearch: null }));
    expect(linked.warnings).toContainEqual({ code: 'MISSING_PRICE_RESEARCH' });
    expect(JSON.stringify(linked.parts)).toContain('R$ 125.000,00');
    expect(
      labelsOf(guarded(sources({ priceResearch: null }), ['ESTIMATED_VALUE']), 'ESTIMATED_VALUE'),
    ).toEqual([]);

    const manual = sources({
      priceResearch: null,
      term: { ...sources().term, estimatedTotalValue: '99000.00', estimatedValueSource: 'MANUAL' },
    });
    expect(JSON.stringify(assembleTermDraftContext(manual).parts)).not.toContain('99.000');
    expect(labelsOf(guarded(manual, ['ESTIMATED_VALUE']), 'ESTIMATED_VALUE')).toEqual([
      VALUE_PENDING,
    ]);

    // Importado de ETP vinculado à pesquisa: vale; de ETP com valor manual: não.
    const fromEtp = (etpSource: 'PRICE_RESEARCH' | 'MANUAL') =>
      sources({
        priceResearch: null,
        etp: { ...sources().etp, estimatedValueSource: etpSource },
        term: { ...sources().term, estimatedValueSource: 'ETP' },
      });
    expect(
      labelsOf(guarded(fromEtp('PRICE_RESEARCH'), ['ESTIMATED_VALUE']), 'ESTIMATED_VALUE'),
    ).toEqual([]);
    expect(labelsOf(guarded(fromEtp('MANUAL'), ['ESTIMATED_VALUE']), 'ESTIMATED_VALUE')).toEqual([
      VALUE_PENDING,
    ]);
  });

  it('orçamento sigiloso (DEC-030): nenhum valor monetário no contexto, nem em texto livre', () => {
    const input = sources({
      process: { ...sources().process, isBudgetConfidential: true },
      etp: {
        ...sources().etp,
        sections: [{ key: 'ESTIMATES', text: 'Estimativa de R$ 125.000,00 pela mediana.' }],
      },
    });
    const context = assembleTermDraftContext(input);
    expect(context.warnings).toContainEqual({ code: 'BUDGET_CONFIDENTIAL_VALUES_OMITTED' });
    const sent = JSON.stringify(sanitized(input).parts);
    expect(sent).not.toContain('R$');
    expect(sent).not.toContain('125.000');
    expect(sent).not.toContain('1041');
    expect(labelsOf(guarded(input, ['ESTIMATED_VALUE']), 'ESTIMATED_VALUE')).toEqual([
      VALUE_PENDING,
    ]);
  });

  it('seções padrão do TR sem template: as 15 do modelo semeado, estruturadas como complemento', () => {
    const context = assembleTermDraftContext(sources());
    expect(context.sections.map((section) => section.sectionKey)).toEqual(
      TERM_DEFAULT_SECTIONS.map((section) => section.key),
    );
    expect(context.sections).toHaveLength(15);
    const guide = JSON.stringify(context.parts.at(-1)?.data);
    expect(guide).toContain('Texto complementar');
  });
});

describe('TermConditionGuard (RN-AI-44 — condições só dos campos tipados)', () => {
  it('marcas pelas condições ausentes, valor sem pesquisa e dotação; só a dotação com tudo preenchido', () => {
    expect(
      termPendingMarks({ conditions: EMPTY, hasGroundedValue: false }).map((mark) => [
        mark.sectionKey,
        mark.label,
      ]),
    ).toEqual([
      ['OBJECT', DURATION_PENDING],
      ['DEADLINES', DURATION_PENDING],
      ['DEADLINES', EXECUTION_PENDING],
      ['DELIVERY', EXECUTION_PENDING],
      ['PAYMENT', PAYMENT_PENDING],
      ['GUARANTEES', WARRANTY_PENDING],
      ['GUARANTEES', GUARANTEE_PENDING],
      ['DELIVERY', LOCATION_PENDING],
      ['CONTRACTOR_OBLIGATIONS', SUBCONTRACTING_PENDING],
      ['SELECTION_CRITERIA', CRITERION_PENDING],
      ['SELECTION_CRITERIA', 'forma de adjudicação'],
      ['ESTIMATED_VALUE', VALUE_PENDING],
      ['BUDGET_ADEQUACY', BUDGET_PENDING],
    ]);
    expect(
      termPendingMarks({ conditions: FILLED, hasGroundedValue: true }).map((mark) => mark.label),
    ).toEqual([BUDGET_PENDING]);
  });

  it('acrescenta a marcação que faltar (local de entrega), não duplica e é idempotente; seção ausente fica de fora', () => {
    const input = sources();
    const raw = output(['DELIVERY', 'PAYMENT', 'DEADLINES']);
    const delivery = raw.sections.find((section) => section.sectionKey === 'DELIVERY');
    (delivery?.content as { content: RichTextNode[] }).content.push({
      type: 'paragraph',
      content: [toConfirmNode(LOCATION_PENDING, 'DATA')],
    });
    const [guard] = assembleTermDraftContext(input).postProcessors;
    if (guard === undefined) throw new Error('sem guarda');
    expect(guard.name).toBe('term-condition-guard');
    const first = guard.process({ output: raw, context: sanitized(input) });
    expect(labelsOf(first, 'DELIVERY')).toEqual([LOCATION_PENDING, EXECUTION_PENDING]);
    // Prazo de pagamento e vigência preenchidos: nada a marcar.
    expect(labelsOf(first, 'PAYMENT')).toEqual([]);
    expect(labelsOf(first, 'DEADLINES')).toEqual([EXECUTION_PENDING]);
    expect(guard.process({ output: first, context: sanitized(input) })).toEqual(first);
    const section = first.sections.find((entry) => entry.sectionKey === 'DELIVERY');
    expect(countToConfirm(section?.content as { content: RichTextNode[] })).toBe(2);
  });

  it('GroundingGuard sobre o mesmo contexto: multa de 20% vira [a confirmar]; prazos tipados e citações legais ficam', () => {
    const input = sources();
    const result = new GroundingGuard().process({
      output: output(
        ['SANCTIONS', 'DEADLINES', 'PAYMENT'],
        [
          paragraph(
            'Multa de 20% sobre o valor do contrato, nos termos do art. 156 da Lei 14.133/2021; vigência de 12 meses e pagamento em 30 dias.',
          ),
        ],
      ),
      context: sanitized(input),
    });
    const sanctions = JSON.stringify(result.sections[0]?.content);
    expect(sanctions).not.toContain('20%');
    expect(sanctions).toContain('art. 156');
    expect(sanctions).toContain('Lei 14.133/2021');
    expect(sanctions).toContain('12 meses');
    expect(sanctions).toContain('30 dias');
    expect(result.sections[0]?.groundingReplacements).toBe(1);
  });

  it('GroundingGuard: prazo inventado (TR sem prazo de pagamento) vira [a confirmar]', () => {
    const input = sources({ term: { ...sources().term, conditions: EMPTY } });
    const result = new GroundingGuard().process({
      output: output(['PAYMENT'], [paragraph('Pagamento em 45 dias após o atesto.')]),
      context: sanitized(input),
    });
    expect(JSON.stringify(result.sections[0]?.content)).not.toContain('45 dias');
    expect(result.sections[0]?.groundingReplacements).toBe(1);
  });
});
