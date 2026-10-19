import { describe, expect, it } from 'vitest';

import { sanitizeContext } from './context-sanitizer.js';
import { GroundingGuard } from './grounding-guard.js';
import { blocksToDoc, countToConfirm } from './output-converter.js';
import {
  SECTION_ADJUST_CHAIN,
  SectionNoLongerAdjustableError,
  assembleSectionAdjustContext,
  sectionAdjustProblem,
  sectionDefinitionOf,
} from './section-adjust-context.js';
import type { SectionAdjustSources } from './section-adjust-context.js';

const TEXT =
  'A Secretaria de Educação precisa de 120 computadores para os laboratórios, ao custo estimado de R$ 15.000,00, em até 30 dias. [a confirmar: local de entrega]';

const DEFINITION = {
  key: 'NEED_DESCRIPTION',
  title: 'Descrição da necessidade',
  requirement: 'REQUIRED',
  helpText: 'Descreva o problema a resolver.',
  legalBasis: 'Lei 14.133/2021, art. 18, §1º, I',
  defaultText: null,
  maxChars: 5_000,
  render: 'TEXT',
  allowNarrative: true,
} as const;

function sources(overrides: Partial<SectionAdjustSources> = {}): SectionAdjustSources {
  return {
    targetModule: 'ETP',
    sectionKey: 'NEED_DESCRIPTION',
    process: {
      id: '0192d121-0000-7000-8000-000000000001',
      code: '0012/2026',
      title: 'Compra de computadores',
      object: 'Aquisição de computadores',
      description: null,
      contractingType: 'Aquisição de bens',
      modality: null,
      isPriceRegistration: false,
      priority: 'HIGH',
      isBudgetConfidential: false,
    },
    document: {
      documentId: '0192d121-0000-7000-8000-000000000002',
      documentTypeCode: 'ETP',
      draftRevision: 7,
      template: { versionId: '0192d121-0000-7000-8000-000000000003', versionNumber: 2 },
      definition: DEFINITION,
      state: 'FILLED',
      revision: 3,
      text: TEXT,
      otherSections: [
        { key: 'OBJECTIVE', title: 'Objetivo', text: 'Modernizar os laboratórios.' },
        { key: 'ESTIMATES', title: 'Estimativas', text: 'R$ 99.999,00' },
      ],
    },
    chain: [
      {
        module: 'DFD',
        document: {
          documentId: '0192d121-0000-7000-8000-000000000004',
          documentTypeCode: 'DFD',
          source: 'APPROVED_VERSION',
          versionNumber: 1,
          draftRevision: null,
          sections: [{ key: 'JUSTIFICATION', text: 'Equipamentos obsoletos.' }],
        },
      },
    ],
    organization: {
      id: '0192d121-0000-7000-8000-000000000005',
      name: 'Prefeitura de São José',
      city: 'São José',
      state: 'SC',
    },
    ...overrides,
  };
}

describe('SectionAdjustPolicy (US-121 · RN-AI-48 · V-02/V-03)', () => {
  const section = sources().document;

  it('REWRITE/SUMMARIZE exigem 50 caracteres; COMPLETE aceita a seção vazia', () => {
    const short = { ...section, text: 'Texto curto de vinte.' };
    expect(sectionAdjustProblem('ETP', 'REWRITE', 'NEED_DESCRIPTION', short)).toBe(
      'AI_SECTION_EMPTY',
    );
    expect(sectionAdjustProblem('ETP', 'SUMMARIZE', 'NEED_DESCRIPTION', short)).toBe(
      'AI_SECTION_EMPTY',
    );
    expect(
      sectionAdjustProblem('ETP', 'COMPLETE', 'NEED_DESCRIPTION', {
        ...section,
        state: 'EMPTY',
        text: '',
      }),
    ).toBeNull();
  });

  it('fora do template, sem narrativa ou "não se aplica" → AI_SECTION_NOT_SUPPORTED', () => {
    expect(
      sectionAdjustProblem('ETP', 'COMPLETE', 'NEED_DESCRIPTION', { ...section, definition: null }),
    ).toBe('AI_SECTION_NOT_SUPPORTED');
    expect(
      sectionAdjustProblem('ETP', 'COMPLETE', 'NEED_DESCRIPTION', {
        ...section,
        definition: { ...DEFINITION, render: 'ITEMS_TABLE', allowNarrative: false },
      }),
    ).toBe('AI_SECTION_NOT_SUPPORTED');
    expect(
      sectionAdjustProblem('ETP', 'COMPLETE', 'NEED_DESCRIPTION', {
        ...section,
        state: 'NOT_APPLICABLE',
      }),
    ).toBe('AI_SECTION_NOT_SUPPORTED');
  });

  it('DFD sem template fixado usa as seções padrão; os demais documentos, não', () => {
    const bare = { template: null, definition: null };
    expect(sectionDefinitionOf('DFD', bare, 'JUSTIFICATION')?.title).toBe(
      'Justificativa da necessidade',
    );
    expect(sectionDefinitionOf('DFD', bare, 'OUTRA')).toBeNull();
    expect(sectionDefinitionOf('ETP', bare, 'JUSTIFICATION')).toBeNull();
  });
});

describe('SectionAdjustContextAssembler (US-121 · RN-AI-48/51)', () => {
  it('a saída é UMA seção, a pedida, com o limite e a base legal do template', () => {
    const context = assembleSectionAdjustContext(sources(), 'REWRITE');
    expect(context.sections).toEqual([
      {
        sectionKey: 'NEED_DESCRIPTION',
        title: 'Descrição da necessidade',
        maxChars: 5_000,
        legalBasis: 'Lei 14.133/2021, art. 18, §1º, I',
      },
    ]);
  });

  it('entradas: SECTION com a revisão, guia, processo, demais seções, cadeia e órgão', () => {
    const context = assembleSectionAdjustContext(sources(), 'REWRITE');
    expect(context.parts.map((part) => part.ref.kind)).toEqual([
      'SECTION',
      'TEMPLATE_VERSION',
      'PROCESS',
      'DOCUMENT_DRAFT',
      'DOCUMENT_VERSION',
      'ORGANIZATION',
    ]);
    expect(context.parts[0]?.ref).toEqual({
      kind: 'SECTION',
      id: 'NEED_DESCRIPTION',
      documentTypeCode: 'ETP',
      revision: 3,
    });
    // O texto atual é obrigatório; o resto pode sair se o contexto não couber.
    expect(context.parts[0]?.optional).toBeUndefined();
    expect(context.parts[3]?.optional).toBe(true);
    expect(context.warnings).toEqual([]);
  });

  it('seções de valor nunca entram (RN-AI-05) e o orçamento sigiloso passa para a sanitização', () => {
    const context = assembleSectionAdjustContext(
      sources({ process: { ...sources().process, isBudgetConfidential: true } }),
      'REWRITE',
    );
    expect(JSON.stringify(context.parts)).not.toContain('99.999');
    expect(context.isBudgetConfidential).toBe(true);
  });

  it('antecessores ausentes viram MISSING_OPTIONAL_INPUT; rascunho, USED_DRAFT_INPUTS (sem exigir nenhum)', () => {
    expect(SECTION_ADJUST_CHAIN.TERM_OF_REFERENCE).toEqual(['DFD', 'ETP', 'RISK_MAP']);
    const context = assembleSectionAdjustContext(
      sources({
        targetModule: 'TERM_OF_REFERENCE',
        chain: [
          {
            module: 'DFD',
            document: {
              documentId: '0192d121-0000-7000-8000-000000000004',
              documentTypeCode: 'DFD',
              source: 'DRAFT',
              versionNumber: null,
              draftRevision: 4,
              sections: [],
            },
          },
          { module: 'ETP', document: null },
          { module: 'RISK_MAP', document: null },
        ],
      }),
      'COMPLETE',
    );
    expect(context.warnings).toEqual([
      { code: 'USED_DRAFT_INPUTS', params: { input: 'DFD' } },
      { code: 'MISSING_OPTIONAL_INPUT', params: { input: 'ETP' } },
      { code: 'MISSING_OPTIONAL_INPUT', params: { input: 'RISK_MAP' } },
    ]);
  });

  it('seção que deixou de ser ajustável no job → SectionNoLongerAdjustableError', () => {
    const base = sources();
    expect(() =>
      assembleSectionAdjustContext(
        { ...base, document: { ...base.document, state: 'NOT_APPLICABLE' } },
        'COMPLETE',
      ),
    ).toThrow(SectionNoLongerAdjustableError);
  });

  it('GroundingGuard com o texto atual como fato: valores da pessoa ficam, o inventado vira [a confirmar] e as marcações são preservadas', () => {
    const context = assembleSectionAdjustContext(sources(), 'REWRITE');
    const sanitized = sanitizeContext(context.parts, {
      isBudgetConfidential: false,
      maxChars: 240_000,
    });
    const doc = blocksToDoc([
      {
        type: 'paragraph',
        text: 'São necessários 120 computadores, ao custo de R$ 15.000,00, em até 30 dias; o reforço custaria R$ 90.000,00. [a confirmar: local de entrega]',
      },
    ]);
    const grounded = new GroundingGuard().process({
      output: {
        sections: [
          {
            sectionKey: 'NEED_DESCRIPTION',
            title: 'Descrição da necessidade',
            content: doc,
            placeholdersCount: countToConfirm(doc),
            groundingReplacements: 0,
          },
        ],
        warnings: [],
      },
      context: sanitized,
    });
    const [section] = grounded.sections;
    const text = JSON.stringify(section?.content);
    expect(text).toContain('R$ 15.000,00');
    expect(text).toContain('120 computadores');
    expect(text).toContain('30 dias');
    expect(text).not.toContain('90.000');
    expect(section?.groundingReplacements).toBe(1);
    expect(text).toContain('local de entrega');
  });
});
