import { describe, expect, it } from 'vitest';

import {
  ETP_SECTION_MESSAGES,
  etpCompletionSummary,
  etpSectionHasNarrative,
  etpSectionNav,
  etpStructuredKind,
  notApplicableJustificationMessage,
  notApplicableJustificationProblem,
} from './etp-sections.js';
import { etpDetailMetaSchema, etpDetailSchema, etpIdParamsSchema } from './etp.js';
import type { DraftContent } from '../document/document.js';

const AT = '2026-10-18T15:00:00.000Z';
const USER = '0192d020-0000-7000-8000-000000000001';

const section = (state: 'EMPTY' | 'FILLED' | 'NOT_APPLICABLE', revision = 1) => ({
  state,
  content: state === 'FILLED' ? { type: 'doc' as const, content: [] } : null,
  justification: state === 'NOT_APPLICABLE' ? 'Solução única no mercado nacional.' : null,
  revision,
  updatedAt: AT,
  updatedById: USER,
});

describe('etpStructuredKind (RN-ETP-12)', () => {
  it('o render estruturado decide o quadro', () => {
    expect(etpStructuredKind({ key: 'X', render: 'ITEMS_TABLE' })).toBe('ITEMS');
    expect(etpStructuredKind({ key: 'X', render: 'ALTERNATIVES_TABLE' })).toBe('ALTERNATIVES');
    expect(etpStructuredKind({ key: 'X', render: 'RISK_LIST' })).toBe('RISKS');
  });

  it('seção TEXT com a chave do conteúdo tipado mostra o quadro do módulo dono', () => {
    expect(etpStructuredKind({ key: 'ESTIMATES', render: 'TEXT' })).toBe('ITEMS');
    expect(etpStructuredKind({ key: 'ALTERNATIVES', render: 'TEXT' })).toBe('ALTERNATIVES');
    expect(etpStructuredKind({ key: 'RISKS', render: 'TEXT' })).toBe('RISKS');
  });

  it('demais seções e renders sem quadro nesta tela', () => {
    expect(etpStructuredKind({ key: 'NEED_DESCRIPTION', render: 'TEXT' })).toBeNull();
    expect(etpStructuredKind({ key: 'ESTIMATES', render: 'PRICE_SUMMARY' })).toBeNull();
  });
});

describe('etpSectionHasNarrative', () => {
  it('TEXT sempre; estruturada só com allowNarrative', () => {
    expect(etpSectionHasNarrative({ render: 'TEXT', allowNarrative: false })).toBe(true);
    expect(etpSectionHasNarrative({ render: 'ITEMS_TABLE', allowNarrative: true })).toBe(true);
    expect(etpSectionHasNarrative({ render: 'ITEMS_TABLE', allowNarrative: false })).toBe(false);
  });
});

describe('etpSectionNav e etpCompletionSummary (RN-ETP-13)', () => {
  const sections = [
    {
      key: 'MARKET_SURVEY',
      title: 'Levantamento de mercado',
      order: 3,
      requirement: 'REQUIRED_OR_JUSTIFY' as const,
    },
    { key: 'NEED_DESCRIPTION', title: 'Necessidade', order: 1, requirement: 'REQUIRED' as const },
    { key: 'OBJECTIVE', title: 'Objetivo', order: 2, requirement: 'OPTIONAL' as const },
    { key: 'CONCLUSION', title: 'Conclusão', order: 4, requirement: 'REQUIRED' as const },
  ];
  const draft: DraftContent = {
    sections: {
      NEED_DESCRIPTION: section('FILLED', 3),
      OBJECTIVE: section('EMPTY'),
      MARKET_SURVEY: section('NOT_APPLICABLE', 2),
    },
  };

  it('ordena pelo template, lê o estado do rascunho (ausente = EMPTY) e agrega as pendências da seção', () => {
    const nav = etpSectionNav(sections, draft, [
      { sectionKey: 'NEED_DESCRIPTION', message: 'A seção deve ter ao menos 100 caracteres.' },
      { sectionKey: null, message: 'Pendência geral.' },
    ]);
    expect(nav.map((item) => [item.key, item.state, item.issues.length])).toEqual([
      ['NEED_DESCRIPTION', 'FILLED', 1],
      ['OBJECTIVE', 'EMPTY', 0],
      ['MARKET_SURVEY', 'NOT_APPLICABLE', 0],
      ['CONCLUSION', 'EMPTY', 0],
    ]);
    expect(nav[0]?.issues).toEqual(['A seção deve ter ao menos 100 caracteres.']);
    expect(etpCompletionSummary(nav)).toEqual({
      total: 4,
      filled: 1,
      notApplicable: 1,
      empty: 2,
      pending: 1,
    });
  });

  it('sem violações informadas, nenhuma pendência', () => {
    expect(etpSectionNav(sections, draft).every((item) => item.issues.length === 0)).toBe(true);
  });
});

describe('notApplicableJustificationProblem (RN-ETP-11 · V-04)', () => {
  it('ausente, curta (sem contar espaços), longa e válida', () => {
    expect(notApplicableJustificationProblem(null)).toBe('REQUIRED');
    expect(notApplicableJustificationProblem('   ')).toBe('REQUIRED');
    expect(notApplicableJustificationProblem('0123456789')).toBe('TOO_SHORT');
    expect(notApplicableJustificationProblem(`  ${'a'.repeat(19)}  `)).toBe('TOO_SHORT');
    expect(notApplicableJustificationProblem('a'.repeat(20))).toBeNull();
    expect(notApplicableJustificationProblem('a'.repeat(2001))).toBe('TOO_LONG');
  });

  it('mensagens da story', () => {
    expect(notApplicableJustificationMessage('TOO_SHORT')).toBe(
      'Explique por que esta seção não se aplica (mín. 20 caracteres).',
    );
    expect(notApplicableJustificationMessage('REQUIRED')).toBe(ETP_SECTION_MESSAGES.justification);
    expect(notApplicableJustificationMessage('TOO_LONG')).toBe(
      'Informe no máximo 2.000 caracteres.',
    );
  });
});

describe('contratos do ETP-03', () => {
  it('etpIdParamsSchema exige UUID v7', () => {
    expect(
      etpIdParamsSchema.safeParse({ id: '0192d020-0000-7000-8000-000000000001' }).success,
    ).toBe(true);
    expect(etpIdParamsSchema.safeParse({ id: 'x' }).success).toBe(false);
  });

  it('etpDetailSchema aceita o rascunho por seção e o valor mascarado', () => {
    const id = '0192d020-0000-7000-8000-000000000002';
    const parsed = etpDetailSchema.parse({
      id,
      documentId: id,
      processId: '0192d020-0000-7000-8000-000000000003',
      code: 'ETP 0003/2026',
      title: 'Estudo Técnico Preliminar — 0012/2026',
      status: 'DRAFT',
      conclusion: 'PENDING',
      importedFromDfdVersionId: null,
      responsibleId: USER,
      templateVersionId: null,
      documentVersion: 1,
      itemsCount: 0,
      createdAt: AT,
      updatedAt: AT,
      version: 1,
      recommendedAlternativeId: null,
      parcelingDecision: null,
      estimatedValueSource: null,
      estimatedTotalValue: null,
      estimatedTotalValueMasked: true,
      priceResearchId: null,
      draftRevision: 4,
      draftContent: { sections: { NEED_DESCRIPTION: section('FILLED', 4) } },
    });
    expect(parsed.draftContent.sections.NEED_DESCRIPTION?.revision).toBe(4);
  });

  it('etpDetailMetaSchema traz render e allowNarrative das seções', () => {
    const meta = etpDetailMetaSchema.parse({
      allowedActions: ['UPDATE'],
      template: {
        versionId: '0192d020-0000-7000-8000-000000000004',
        versionNumber: 1,
        sections: [
          {
            key: 'ESTIMATES',
            title: 'Estimativas',
            order: 8,
            requirement: 'REQUIRED',
            helpText: null,
            legalBasis: null,
            minChars: null,
            maxChars: 50_000,
            render: 'ITEMS_TABLE',
            allowNarrative: true,
          },
        ],
      },
    });
    expect(meta.template?.sections[0]?.render).toBe('ITEMS_TABLE');
    expect(etpDetailMetaSchema.parse({ allowedActions: [], template: null }).template).toBeNull();
  });
});
