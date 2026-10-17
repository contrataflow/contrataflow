import type { Violation } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  composeViolations,
  evaluateGenericCompleteness,
  gateCompleteness,
} from './document-completeness.js';
import type { CompletenessInput } from './document-completeness.js';
import { filledSection, sectionDefinition } from '../../../../test/support/document-fixtures.js';

/*
 * US-065 — validação de completude (DOC-08 · RN-DOC-51 · api.md §2.1.2): regras genéricas, a
 * composição com as do `DocumentValidator` simulado e o portão de finalizar/submeter (V-01/V-02).
 */

const JUSTIFICATION = 'Não se aplica: aquisição de pronta entrega.';

function input(overrides: Partial<CompletenessInput> = {}): CompletenessInput {
  return {
    document: { draftContent: { sections: {} }, currentVersionId: null },
    kind: 'FREE_TEXT',
    sections: [],
    requiredHeaderFields: [],
    header: {},
    ...overrides,
  };
}

const codes = (violations: readonly Violation[]) =>
  violations.map((item) => `${item.code}:${item.sectionKey ?? item.field ?? ''}`);

describe('regras genéricas de seção', () => {
  const sections = [
    sectionDefinition('OBJETO', { order: 2, title: 'Objeto' }),
    sectionDefinition('JUSTIFICATIVA', {
      order: 1,
      title: 'Justificativa',
      requirement: 'REQUIRED_OR_JUSTIFY',
    }),
    sectionDefinition('ANEXOS', { order: 3, title: 'Anexos', requirement: 'OPTIONAL' }),
  ];

  it('rascunho vazio: as obrigatórias pendentes, em ordem; a opcional não', () => {
    const result = evaluateGenericCompleteness(input({ sections }));
    expect(codes(result.violations)).toEqual([
      'SECTION_REQUIRED:JUSTIFICATIVA',
      'SECTION_REQUIRED:OBJETO',
    ]);
    expect(result.violations[0]).toMatchObject({
      severity: 'BLOCKING',
      message: 'Preencha a seção "Justificativa" ou justifique por que ela não se aplica.',
      ruleId: null,
      field: null,
      itemId: null,
      params: {},
    });
    expect(result.sections).toEqual([
      { key: 'JUSTIFICATIVA', requirement: 'REQUIRED_OR_JUSTIFY', state: 'EMPTY', complete: false },
      { key: 'OBJETO', requirement: 'REQUIRED', state: 'EMPTY', complete: false },
      { key: 'ANEXOS', requirement: 'OPTIONAL', state: 'EMPTY', complete: true },
    ]);
  });

  it('preenchidas ou "não se aplica" justificado = completo', () => {
    const result = evaluateGenericCompleteness(
      input({
        sections,
        document: {
          currentVersionId: null,
          draftContent: {
            sections: {
              OBJETO: filledSection('Aquisição de cimento para manutenção de vias.'),
              JUSTIFICATIVA: filledSection('', {
                state: 'NOT_APPLICABLE',
                content: null,
                justification: JUSTIFICATION,
              }),
            },
          },
        },
      }),
    );
    expect(result.violations).toEqual([]);
    expect(result.sections.every((section) => section.complete)).toBe(true);
  });

  it('conteúdo só com espaços conta como vazio', () => {
    const result = evaluateGenericCompleteness(
      input({
        sections: [sectionDefinition('OBJETO', { title: 'Objeto' })],
        document: {
          currentVersionId: null,
          draftContent: { sections: { OBJETO: filledSection('   ') } },
        },
      }),
    );
    expect(codes(result.violations)).toEqual(['SECTION_REQUIRED:OBJETO']);
  });

  it('"não se aplica" em seção REQUIRED não vale; justificativa curta pede justificativa', () => {
    const result = evaluateGenericCompleteness(
      input({
        sections: [
          sectionDefinition('OBJETO', { order: 1 }),
          sectionDefinition('RISCOS', { order: 2, requirement: 'REQUIRED_OR_JUSTIFY' }),
          sectionDefinition('NOTAS', { order: 3, requirement: 'OPTIONAL' }),
        ],
        document: {
          currentVersionId: null,
          draftContent: {
            sections: {
              OBJETO: filledSection('', {
                state: 'NOT_APPLICABLE',
                content: null,
                justification: JUSTIFICATION,
              }),
              RISCOS: filledSection('', {
                state: 'NOT_APPLICABLE',
                content: null,
                justification: 'curta',
              }),
              NOTAS: filledSection('', {
                state: 'NOT_APPLICABLE',
                content: null,
                justification: null,
              }),
            },
          },
        },
      }),
    );
    expect(codes(result.violations)).toEqual([
      'SECTION_REQUIRED:OBJETO',
      'SECTION_JUSTIFICATION_REQUIRED:RISCOS',
      'SECTION_JUSTIFICATION_REQUIRED:NOTAS',
    ]);
    expect(result.violations[1]?.params).toEqual({ minChars: 20 });
  });

  it('abaixo de minChars → SECTION_TOO_SHORT com o tamanho', () => {
    const result = evaluateGenericCompleteness(
      input({
        sections: [sectionDefinition('OBJETO', { title: 'Objeto', minChars: 30 })],
        document: {
          currentVersionId: null,
          draftContent: { sections: { OBJETO: filledSection('Curto demais') } },
        },
      }),
    );
    expect(result.violations).toEqual([
      expect.objectContaining({
        code: 'SECTION_TOO_SHORT',
        sectionKey: 'OBJETO',
        params: { minChars: 30, length: 12 },
      }),
    ]);
  });

  it('conteúdo de IA não revisado bloqueia (RN-AI-57); revisado não', () => {
    const ai = {
      generationId: '0192f065-0000-7000-8000-0000000000e1',
      appliedAt: '2026-10-16T12:00:00.000Z',
      appliedById: '0192f065-0000-7000-8000-0000000000a1',
      reviewedAt: null,
      reviewedById: null,
    };
    const sections = [sectionDefinition('OBJETO')];
    const pending = evaluateGenericCompleteness(
      input({
        sections,
        document: {
          currentVersionId: null,
          draftContent: { sections: { OBJETO: filledSection('Texto gerado', { ai }) } },
        },
      }),
    );
    expect(codes(pending.violations)).toEqual(['SECTION_AI_REVIEW_PENDING:OBJETO']);
    const reviewed = evaluateGenericCompleteness(
      input({
        sections,
        document: {
          currentVersionId: null,
          draftContent: {
            sections: {
              OBJETO: filledSection('Texto gerado', {
                ai: { ...ai, reviewedAt: '2026-10-16T12:30:00.000Z', reviewedById: ai.appliedById },
              }),
            },
          },
        },
      }),
    );
    expect(reviewed.violations).toEqual([]);
  });

  const marker = (label: string) => ({
    type: 'toConfirm',
    attrs: { label, category: 'DEADLINE', origin: 'AI' },
  });
  const withMarkers = (count: number) =>
    filledSection('x', {
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Entrega em ' },
              ...Array.from({ length: count }, () => marker('prazo')),
            ],
          },
        ],
      },
    });

  it('marcações [a confirmar] bloqueiam com params.count (RN-AI-57 · V-08)', () => {
    const result = evaluateGenericCompleteness(
      input({
        sections: [sectionDefinition('OBJETO', { title: 'Objeto' })],
        document: {
          currentVersionId: null,
          draftContent: { sections: { OBJETO: withMarkers(2) } },
        },
      }),
    );
    expect(result.violations).toEqual([
      expect.objectContaining({
        code: 'SECTION_PLACEHOLDER_PENDING',
        severity: 'BLOCKING',
        sectionKey: 'OBJETO',
        params: { count: 2 },
        message: 'Resolva os 2 itens [a confirmar] da seção "Objeto".',
      }),
    ]);
    expect(result.sections[0]?.complete).toBe(false);
    const one = evaluateGenericCompleteness(
      input({
        sections: [sectionDefinition('OBJETO', { title: 'Objeto' })],
        document: {
          currentVersionId: null,
          draftContent: { sections: { OBJETO: withMarkers(1) } },
        },
      }),
    );
    expect(one.violations[0]?.message).toBe('Resolva o item [a confirmar] da seção "Objeto".');
  });

  it('revisão e pendências são independentes (FA-03): as duas violações juntas', () => {
    const ai = {
      generationId: '0192f065-0000-7000-8000-0000000000e1',
      appliedAt: '2026-10-16T12:00:00.000Z',
      appliedById: '0192f065-0000-7000-8000-0000000000a1',
      reviewedAt: null,
      reviewedById: null,
    };
    const result = evaluateGenericCompleteness(
      input({
        sections: [sectionDefinition('OBJETO')],
        document: {
          currentVersionId: null,
          draftContent: { sections: { OBJETO: { ...withMarkers(1), ai } } },
        },
      }),
    );
    expect(codes(result.violations)).toEqual([
      'SECTION_AI_REVIEW_PENDING:OBJETO',
      'SECTION_PLACEHOLDER_PENDING:OBJETO',
    ]);
  });

  it('seção fora do template (ou documento sem template) também bloqueia; "não se aplica" não', () => {
    const result = evaluateGenericCompleteness(
      input({
        document: {
          currentVersionId: null,
          draftContent: {
            sections: {
              LIVRE: withMarkers(1),
              OUTRA: { ...withMarkers(3), state: 'NOT_APPLICABLE' },
            },
          },
        },
      }),
    );
    expect(codes(result.violations)).toEqual(['SECTION_PLACEHOLDER_PENDING:LIVRE']);
  });
});

describe('cabeçalho e documento externo', () => {
  it('campo de cabeçalho obrigatório vazio → FIELD_REQUIRED com o rótulo', () => {
    const result = evaluateGenericCompleteness(
      input({
        kind: 'STRUCTURED',
        requiredHeaderFields: [
          { field: 'requestingUnitHead', label: 'o titular da unidade' },
          { field: 'items', label: 'os itens' },
          { field: 'object', label: 'o objeto' },
        ],
        header: { requestingUnitHead: '  ', items: [], object: 'Cimento' },
      }),
    );
    expect(codes(result.violations)).toEqual([
      'FIELD_REQUIRED:requestingUnitHead',
      'FIELD_REQUIRED:items',
    ]);
    expect(result.violations[0]?.message).toBe('Informe o titular da unidade.');
  });

  it('externo sem arquivo enviado → FIELD_REQUIRED em currentVersionId (RN-DOC-40)', () => {
    expect(codes(evaluateGenericCompleteness(input({ kind: 'UPLOADED' })).violations)).toEqual([
      'FIELD_REQUIRED:currentVersionId',
    ]);
    expect(
      evaluateGenericCompleteness(
        input({
          kind: 'UPLOADED',
          document: { draftContent: { sections: {} }, currentVersionId: 'v1' },
        }),
      ).violations,
    ).toEqual([]);
  });
});

describe('composição com o DocumentValidator do módulo tipado (RN-DOC-51 b)', () => {
  const generic: Violation = {
    code: 'SECTION_REQUIRED',
    severity: 'BLOCKING',
    message: 'Preencha a seção.',
    ruleId: null,
    sectionKey: 'OBJETO',
    field: null,
    itemId: null,
    params: {},
  };
  const typedWarning: Violation = {
    ...generic,
    code: 'ETP_PRICE_OUTDATED',
    severity: 'WARNING',
    sectionKey: null,
  };
  const typedBlocking: Violation = {
    ...generic,
    code: 'DFD_ITEMS_REQUIRED',
    sectionKey: null,
    message: 'Informe ao menos um item com quantidade.',
  };

  it('um único array: bloqueantes antes dos avisos, sem repetir a mesma pendência', () => {
    expect(
      composeViolations([generic], [typedWarning, typedBlocking, generic]).map((item) => item.code),
    ).toEqual(['SECTION_REQUIRED', 'DFD_ITEMS_REQUIRED', 'ETP_PRICE_OUTDATED']);
  });

  it('portão: bloqueante → INCOMPLETE; aviso não reconhecido → WARNINGS_NOT_ACKNOWLEDGED; reconhecido → OK', () => {
    expect(gateCompleteness([typedBlocking, typedWarning], ['ETP_PRICE_OUTDATED']).kind).toBe(
      'INCOMPLETE',
    );
    const pending = gateCompleteness([typedWarning], []);
    expect(pending).toEqual({ kind: 'WARNINGS_NOT_ACKNOWLEDGED', violations: [typedWarning] });
    expect(gateCompleteness([typedWarning], ['ETP_PRICE_OUTDATED'])).toEqual({
      kind: 'OK',
      acknowledged: [typedWarning],
    });
    expect(gateCompleteness([], [])).toEqual({ kind: 'OK', acknowledged: [] });
  });
});
