import { describe, expect, it } from 'vitest';

import { dfdStepOfViolation, evaluateDfdCompleteness, isDfdComplete } from './completeness.js';
import type { DfdCompletenessInput } from './completeness.js';
import {
  DFD_MESSAGES,
  dfdCreateSchema,
  dfdDocumentTitle,
  dfdRequiredFields,
  dfdStepIssues,
} from './dfd.js';
import type { DfdHeaderValues } from './dfd.js';
import {
  documentItemQuantityIssue,
  documentItemsReplaceSchema,
  normalizeQuantity,
} from '../document/document-items.js';

const TODAY = '2026-10-17';
const ITEM = '0192f014-0000-7000-8000-0000000000c1';

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const HEADER: DfdHeaderValues = {
  requestDate: TODAY,
  requestingDepartmentId: '0192f014-0000-7000-8000-0000000000d1',
  responsibleId: '0192f014-0000-7000-8000-0000000000a1',
  objectSummary: 'Aquisição de insumos para a UBS Centro',
  priority: 'MEDIUM',
  expectedDate: '2026-12-15',
  estimatedValue: null,
  pcaStatus: 'PLANNED',
  pcaYear: 2026,
  pcaItemCode: null,
  pcaJustification: null,
};

const SECTIONS = [
  {
    key: 'JUSTIFICATION',
    title: 'Justificativa da necessidade',
    requirement: 'REQUIRED',
    minChars: 50,
  },
  { key: 'EXPECTED_RESULTS', title: 'Resultados esperados', requirement: 'REQUIRED' },
  { key: 'NOTES', title: 'Observações', requirement: 'OPTIONAL' },
] as const;

function input(overrides: Partial<DfdCompletenessInput> = {}): DfdCompletenessInput {
  return {
    header: HEADER,
    sections: {
      JUSTIFICATION: { state: 'FILLED', content: doc('x'.repeat(380)) },
      EXPECTED_RESULTS: { state: 'FILLED', content: doc('Atendimento contínuo da UBS.') },
      NOTES: { state: 'EMPTY', content: null },
    },
    sectionDefinitions: SECTIONS,
    fieldConfig: { expectedDate: { required: true }, estimatedValue: { required: false } },
    items: [
      { processItemId: ITEM, quantity: '120.0000' },
      { processItemId: '0192f014-0000-7000-8000-0000000000c2', quantity: '5000.0000' },
    ],
    pendingAttachments: 0,
    responsibleActive: true,
    departmentActive: true,
    today: TODAY,
    ...overrides,
  };
}

const codes = (
  violations: readonly { code: string; field: string | null; sectionKey: string | null }[],
) => violations.map((item) => [item.code, item.field ?? item.sectionKey]);

describe('evaluateDfdCompleteness (RN-DFD-18/19)', () => {
  it('DFD completo: sem pendências e isComplete', () => {
    const violations = evaluateDfdCompleteness(input());
    expect(violations).toEqual([]);
    expect(isDfdComplete(violations)).toBe(true);
  });

  it('Revisão com pendências: SECTION_REQUIRED, DFD_ITEMS_REQUIRED e FIELD_REQUIRED de expectedDate', () => {
    const violations = evaluateDfdCompleteness(
      input({
        header: { ...HEADER, expectedDate: null },
        sections: {
          JUSTIFICATION: { state: 'EMPTY', content: null },
          EXPECTED_RESULTS: { state: 'FILLED', content: doc('Atendimento contínuo.') },
        },
        items: [],
      }),
    );
    expect(codes(violations)).toEqual([
      ['FIELD_REQUIRED', 'expectedDate'],
      ['SECTION_REQUIRED', 'JUSTIFICATION'],
      ['DFD_ITEMS_REQUIRED', 'items'],
    ]);
    expect(violations.every((item) => item.severity === 'BLOCKING')).toBe(true);
    expect(isDfdComplete(violations)).toBe(false);
  });

  it('Campos sempre obrigatórios (RN-DFD-08) e fieldConfig decide expectedDate/estimatedValue', () => {
    const blank: DfdHeaderValues = {
      ...HEADER,
      requestDate: null,
      requestingDepartmentId: ' ',
      responsibleId: null,
      objectSummary: '',
      priority: null,
      pcaStatus: null,
      expectedDate: null,
    };
    const violations = evaluateDfdCompleteness(
      input({ header: blank, fieldConfig: { estimatedValue: { required: true } } }),
    );
    expect(codes(violations).filter(([code]) => code === 'FIELD_REQUIRED')).toEqual([
      ['FIELD_REQUIRED', 'requestDate'],
      ['FIELD_REQUIRED', 'requestingDepartmentId'],
      ['FIELD_REQUIRED', 'responsibleId'],
      ['FIELD_REQUIRED', 'objectSummary'],
      ['FIELD_REQUIRED', 'priority'],
      ['FIELD_REQUIRED', 'pcaStatus'],
      ['FIELD_REQUIRED', 'expectedDate'],
      ['FIELD_REQUIRED', 'estimatedValue'],
    ]);
    // Valor mascarado (POL-09) não é conferido por quem não o vê.
    const masked = evaluateDfdCompleteness(
      input({
        header: { ...HEADER, estimatedValueMasked: true },
        fieldConfig: { estimatedValue: { required: true }, expectedDate: { required: true } },
      }),
    );
    expect(masked).toEqual([]);
  });

  it('SECTION_TOO_SHORT abaixo de minChars; NOT_APPLICABLE de seção REQUIRED_OR_JUSTIFY passa', () => {
    const violations = evaluateDfdCompleteness(
      input({
        sections: {
          JUSTIFICATION: { state: 'FILLED', content: doc('  curta  ') },
          EXPECTED_RESULTS: { state: 'NOT_APPLICABLE', content: null },
        },
        sectionDefinitions: [
          SECTIONS[0],
          { key: 'EXPECTED_RESULTS', title: 'Resultados', requirement: 'REQUIRED_OR_JUSTIFY' },
        ],
      }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      code: 'SECTION_TOO_SHORT',
      sectionKey: 'JUSTIFICATION',
      params: { minChars: 50, length: 5 },
    });
  });

  it('Itens sem quantidade positiva contam como ausentes', () => {
    const violations = evaluateDfdCompleteness(
      input({
        items: [
          { processItemId: ITEM, quantity: '0' },
          { processItemId: ITEM, quantity: null },
        ],
      }),
    );
    expect(codes(violations)).toEqual([['DFD_ITEMS_REQUIRED', 'items']]);
  });

  it('PCA (RN-DFD-13): exercício ausente ou fora da faixa; justificativa curta fora do PCA', () => {
    expect(codes(evaluateDfdCompleteness(input({ header: { ...HEADER, pcaYear: null } })))).toEqual(
      [['DFD_PCA_INCOMPLETE', 'pcaYear']],
    );
    const outOfRange = evaluateDfdCompleteness(input({ header: { ...HEADER, pcaYear: 2030 } }));
    expect(outOfRange[0]?.message).toBe(DFD_MESSAGES.pcaYearRange);
    expect(
      codes(
        evaluateDfdCompleteness(
          input({
            header: {
              ...HEADER,
              pcaStatus: 'NOT_PLANNED',
              pcaYear: null,
              pcaJustification: 'curta',
            },
          }),
        ),
      ),
    ).toEqual([['DFD_PCA_INCOMPLETE', 'pcaJustification']]);
    expect(
      evaluateDfdCompleteness(
        input({ header: { ...HEADER, pcaStatus: 'NOT_APPLICABLE', pcaYear: null } }),
      ),
    ).toEqual([]);
  });

  it('Previsão no passado, responsável inativo e setor desativado bloqueiam', () => {
    const violations = evaluateDfdCompleteness(
      input({
        header: { ...HEADER, requestDate: '2026-10-01', expectedDate: '2026-10-10' },
        responsibleActive: false,
        departmentActive: false,
      }),
    );
    expect(codes(violations)).toEqual([
      ['DFD_EXPECTED_DATE_PAST', 'expectedDate'],
      ['DFD_RESPONSIBLE_INACTIVE', 'responsibleId'],
      ['DFD_DEPARTMENT_INACTIVE', 'requestingDepartmentId'],
    ]);
  });

  it('Anexos em verificação geram só o aviso DFD_ATTACHMENTS_PENDING (não bloqueia)', () => {
    const violations = evaluateDfdCompleteness(input({ pendingAttachments: 2 }));
    expect(violations).toEqual([
      {
        code: 'DFD_ATTACHMENTS_PENDING',
        severity: 'WARNING',
        message: 'Há 2 anexos em verificação de segurança.',
        ruleId: null,
        sectionKey: null,
        field: 'attachments',
        itemId: null,
        params: { count: 2 },
      },
    ]);
    expect(isDfdComplete(violations)).toBe(true);
    expect(DFD_MESSAGES.attachmentsPending(1)).toBe('Há 1 anexo em verificação de segurança.');
  });
});

describe('dfdStepOfViolation (RN-DFD-19)', () => {
  it.each([
    [{ field: 'requestDate', sectionKey: null }, 'IDENTIFICATION'],
    [{ field: 'responsibleId', sectionKey: null }, 'IDENTIFICATION'],
    [{ field: null, sectionKey: 'JUSTIFICATION' }, 'JUSTIFICATION'],
    [{ field: null, sectionKey: 'NOTES' }, 'PLANNING'],
    [{ field: 'attachments', sectionKey: null }, 'JUSTIFICATION'],
    [{ field: 'items', sectionKey: null }, 'PLANNING'],
    [{ field: 'expectedDate', sectionKey: null }, 'PLANNING'],
    [{ field: null, sectionKey: null }, 'PLANNING'],
  ] as const)('%o → %s', (violation, step) => {
    expect(dfdStepOfViolation(violation)).toBe(step);
  });
});

describe('dfdStepIssues (V-05/V-08/V-12/V-13)', () => {
  const context = { fieldConfig: { expectedDate: { required: true } }, today: TODAY };

  it('Identificação: obrigatórios, data futura e tamanho do objeto', () => {
    expect(
      dfdStepIssues(
        'IDENTIFICATION',
        { ...HEADER, responsibleId: null, objectSummary: 'curto' },
        context,
      ),
    ).toEqual({
      responsibleId: DFD_MESSAGES.responsibleRequired,
      objectSummary: DFD_MESSAGES.objectLength,
    });
    expect(
      dfdStepIssues('IDENTIFICATION', { ...HEADER, requestDate: '2026-10-18' }, context),
    ).toEqual({ requestDate: DFD_MESSAGES.requestDateFuture });
    expect(dfdStepIssues('IDENTIFICATION', HEADER, context)).toEqual({});
  });

  it('Planejamento: previsão, estimativa, PCA e item do PCA', () => {
    expect(
      dfdStepIssues(
        'PLANNING',
        {
          ...HEADER,
          expectedDate: '2026-10-01',
          requestDate: '2026-10-10',
          estimatedValue: '-1',
          pcaYear: null,
          pcaItemCode: 'x'.repeat(61),
        },
        context,
      ),
    ).toEqual({
      expectedDate: DFD_MESSAGES.expectedDateBeforeRequest,
      estimatedValue: DFD_MESSAGES.estimatedValueInvalid,
      pcaYear: DFD_MESSAGES.pcaYearRequired,
      pcaItemCode: DFD_MESSAGES.pcaItemCodeLength,
    });
    expect(
      dfdStepIssues('PLANNING', { ...HEADER, expectedDate: null, pcaYear: 2028 }, context),
    ).toEqual({
      expectedDate: DFD_MESSAGES.expectedDateRequired,
      pcaYear: DFD_MESSAGES.pcaYearRange,
    });
    expect(
      dfdStepIssues(
        'PLANNING',
        {
          ...HEADER,
          pcaStatus: 'NOT_PLANNED',
          pcaJustification: 'curta',
          estimatedValue: '15000.00',
        },
        context,
      ),
    ).toEqual({ pcaJustification: DFD_MESSAGES.pcaJustificationRequired });
    expect(
      dfdStepIssues(
        'PLANNING',
        { ...HEADER, estimatedValue: 'abc', estimatedValueMasked: true },
        context,
      ),
    ).toEqual({});
    expect(dfdStepIssues('REVIEW', { ...HEADER, priority: null }, context)).toEqual({});
  });

  it('dfdRequiredFields soma o fieldConfig aos sempre obrigatórios', () => {
    // RN-TPL-31: fieldConfig vazio = padrões do módulo (previsão obrigatória, estimativa não).
    expect(dfdRequiredFields({})).toContain('expectedDate');
    expect(dfdRequiredFields({})).not.toContain('estimatedValue');
    expect(dfdRequiredFields({ expectedDate: { required: false } })).not.toContain('expectedDate');
    expect(dfdRequiredFields({ estimatedValue: { required: true } })).toContain('estimatedValue');
  });
});

describe('Contratos do DFD e dos itens', () => {
  it('dfdCreateSchema aceita corpo vazio e templateId UUIDv7; recusa extras', () => {
    expect(dfdCreateSchema.safeParse({}).success).toBe(true);
    expect(dfdCreateSchema.safeParse({ templateId: ITEM }).success).toBe(true);
    expect(dfdCreateSchema.safeParse({ templateId: 'x' }).success).toBe(false);
    expect(dfdCreateSchema.safeParse({ other: 1 }).success).toBe(false);
  });

  it('dfdDocumentTitle (RN-DFD-06): prefixo e truncamento em 250', () => {
    expect(dfdDocumentTitle(' Aquisição de insumos ')).toBe('DFD — Aquisição de insumos');
    const long = dfdDocumentTitle('x'.repeat(400));
    expect(long).toHaveLength(250);
    expect(long.endsWith('…')).toBe(true);
  });

  it('documentItemQuantityIssue (V-09 · FA-11)', () => {
    expect(documentItemQuantityIssue('120', false)).toBeNull();
    expect(documentItemQuantityIssue('2.0000', false)).toBeNull();
    expect(documentItemQuantityIssue('2.5', true)).toBeNull();
    expect(documentItemQuantityIssue('2.5', false)).toEqual({
      code: 'INVALID_DECIMAL',
      message: 'Esta unidade aceita apenas números inteiros.',
    });
    expect(documentItemQuantityIssue('0', true)?.code).toBe('OUT_OF_RANGE');
    expect(documentItemQuantityIssue('-1', true)?.code).toBe('INVALID_DECIMAL');
    expect(documentItemQuantityIssue('1.12345', true)?.code).toBe('INVALID_DECIMAL');
    expect(documentItemQuantityIssue(' ', true)?.code).toBe('REQUIRED');
    expect(documentItemQuantityIssue(null, true)?.code).toBe('REQUIRED');
  });

  it('normalizeQuantity devolve 4 casas como numeric(18,4)', () => {
    expect(normalizeQuantity('120')).toBe('120.0000');
    expect(normalizeQuantity('0040.5')).toBe('40.5000');
  });

  it('documentItemsReplaceSchema: coleção com processItemId e quantidade', () => {
    expect(
      documentItemsReplaceSchema.safeParse({ items: [{ processItemId: ITEM, quantity: '1' }] })
        .success,
    ).toBe(true);
    expect(documentItemsReplaceSchema.safeParse({ items: [{ processItemId: ITEM }] }).success).toBe(
      false,
    );
  });
});
