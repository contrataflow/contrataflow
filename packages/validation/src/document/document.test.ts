import { describe, expect, it } from 'vitest';

import {
  approvalPolicySchema,
  documentTypeCreateSchema,
  documentTypeListQuerySchema,
  documentTypeUpdateSchema,
} from './document-type.js';
import { DocumentTypeChanged } from './events.js';
import {
  isValidNumberingMask,
  numberingMaskProblem,
  renderNumberingMask,
  suggestDocumentTypeCode,
} from './numbering-mask.js';

const USER = '0192f000-0000-7000-8000-0000000000a1';
const DEPARTMENT = '0192f000-0000-7000-8000-0000000000d1';

const base = {
  kind: 'FREE_TEXT',
  code: 'PARECER_TECNICO',
  name: 'Parecer técnico',
  allowMultiplePerProcess: true,
  numberingEnabled: true,
  numberingMask: 'PT {seq:3}/{year}',
  requiresApproval: false,
  defaultConfidentiality: 'INTERNAL',
} as const;

function fieldCodes(result: { success: boolean; error?: { issues: readonly unknown[] } }) {
  return (result.error?.issues ?? []).map((issue) => {
    const { path, code, params } = issue as {
      path: PropertyKey[];
      code: string;
      params?: { code?: string };
    };
    return `${path.join('.')}:${params?.code ?? code}`;
  });
}

describe('numberingMaskProblem (RN-DOC-05)', () => {
  it.each(['PT {seq:3}/{year}', '{type} {seq:4}/{year}', '{org}-{seq:8}/{year}-{type}'])(
    'aceita %s',
    (mask) => {
      expect(isValidNumberingMask(mask)).toBe(true);
    },
  );

  it.each([
    ['PT {seq:3}', 'MISSING_YEAR'],
    ['PT {year}', 'MISSING_SEQ'],
    ['PT {seq:9}/{year}', 'UNKNOWN_TOKEN'],
    ['PT {seq:0}/{year}', 'UNKNOWN_TOKEN'],
    ['PT {seq}/{year}', 'UNKNOWN_TOKEN'],
    ['PT {seq:3}/{year}/{dia}', 'UNKNOWN_TOKEN'],
    ['PT {seq:3}{seq:3}/{year}', 'DUPLICATE_TOKEN'],
    ['PT {seq:3}/{year', 'STRAY_BRACE'],
    [`${'A'.repeat(60)}{seq:3}{year}`, 'TOO_LONG'],
  ])('recusa %s (%s)', (mask, problem) => {
    expect(numberingMaskProblem(mask)).toBe(problem);
  });

  it('gera a prévia do próximo número', () => {
    expect(
      renderNumberingMask({
        mask: 'PT {seq:3}/{year}',
        typeCode: 'PARECER',
        sequence: 1,
        year: 2026,
      }),
    ).toBe('PT 001/2026');
    expect(
      renderNumberingMask({
        mask: '{type} {seq:4}/{year}',
        typeCode: 'OFICIO',
        sequence: 12,
        year: 2026,
      }),
    ).toBe('OFICIO 0012/2026');
  });

  it('sugere o código a partir do nome', () => {
    expect(suggestDocumentTypeCode('Parecer técnico')).toBe('PARECER_TECNICO');
    expect(suggestDocumentTypeCode('  Portaria de designação (fiscal) ')).toBe(
      'PORTARIA_DE_DESIGNACAO_FISCAL',
    );
    expect(suggestDocumentTypeCode('2ª certidão')).toBe('T_2_CERTIDAO');
    expect(suggestDocumentTypeCode('')).toBe('');
  });
});

describe('documentTypeCreateSchema (V-01..V-03, V-07)', () => {
  it('aceita um tipo de texto livre completo', () => {
    expect(documentTypeCreateSchema.safeParse(base).success).toBe(true);
  });

  it('recusa kind STRUCTURED com INVALID_ENUM (V-03)', () => {
    const result = documentTypeCreateSchema.safeParse({ ...base, kind: 'STRUCTURED' });
    expect(fieldCodes(result)).toEqual(['kind:invalid_value']);
  });

  it.each(['parecer', 'P', '1ABC', 'PARECER-TECNICO', 'A'.repeat(41)])(
    'recusa o código %s (V-02)',
    (code) => {
      expect(documentTypeCreateSchema.safeParse({ ...base, code }).success).toBe(false);
    },
  );

  it('recusa nome curto (V-01) e descrição acima de 2.000 caracteres', () => {
    expect(documentTypeCreateSchema.safeParse({ ...base, name: 'ab' }).success).toBe(false);
    expect(
      documentTypeCreateSchema.safeParse({ ...base, description: 'x'.repeat(2001) }).success,
    ).toBe(false);
  });

  it('exige approvalPolicy quando requiresApproval (V-07)', () => {
    const result = documentTypeCreateSchema.safeParse({ ...base, requiresApproval: true });
    expect(fieldCodes(result)).toEqual(['approvalPolicy:CONDITIONAL_REQUIRED']);
  });

  it('recusa campos desconhecidos (sem ignorar em silêncio)', () => {
    expect(documentTypeCreateSchema.safeParse({ ...base, isSystem: true }).success).toBe(false);
  });
});

describe('approvalPolicySchema (RN-DOC-07 sintática · V-11)', () => {
  it('USER exige approverUserId; ROLE exige approverRoleId', () => {
    expect(
      fieldCodes(approvalPolicySchema.safeParse({ approverType: 'USER', allowDeputy: true })),
    ).toEqual(['approverUserId:CONDITIONAL_REQUIRED']);
    expect(
      fieldCodes(approvalPolicySchema.safeParse({ approverType: 'ROLE', allowDeputy: true })),
    ).toEqual(['approverRoleId:CONDITIONAL_REQUIRED']);
  });

  it('DEPARTMENT_HEAD exige a resolução e, se FIXED, a unidade', () => {
    expect(
      fieldCodes(
        approvalPolicySchema.safeParse({ approverType: 'DEPARTMENT_HEAD', allowDeputy: true }),
      ),
    ).toEqual(['approverDepartmentResolution:CONDITIONAL_REQUIRED']);
    expect(
      fieldCodes(
        approvalPolicySchema.safeParse({
          approverType: 'DEPARTMENT_HEAD',
          approverDepartmentResolution: 'FIXED',
          allowDeputy: false,
        }),
      ),
    ).toEqual(['approverFixedDepartmentId:CONDITIONAL_REQUIRED']);
    expect(
      approvalPolicySchema.safeParse({
        approverType: 'DEPARTMENT_HEAD',
        approverDepartmentResolution: 'FIXED',
        approverFixedDepartmentId: DEPARTMENT,
        allowDeputy: false,
        slaDays: 3,
        slaType: 'BUSINESS',
      }).success,
    ).toBe(true);
  });

  it.each([0, 366, 1.5])('recusa slaDays %s', (slaDays) => {
    expect(
      approvalPolicySchema.safeParse({
        approverType: 'USER',
        approverUserId: USER,
        allowDeputy: true,
        slaDays,
      }).success,
    ).toBe(false);
  });

  it('allowDeputy é obrigatório', () => {
    expect(
      approvalPolicySchema.safeParse({ approverType: 'USER', approverUserId: USER }).success,
    ).toBe(false);
  });
});

describe('documentTypeUpdateSchema (RN-DOC-02/03 · V-04)', () => {
  it('aceita só campos editáveis (corpo vazio é uma alteração nula)', () => {
    expect(documentTypeUpdateSchema.safeParse({ name: 'Ofício externo' }).success).toBe(true);
    expect(documentTypeUpdateSchema.safeParse({}).success).toBe(true);
  });

  it.each(['code', 'kind', 'systemModule', 'isSystem', 'defaultTemplateId'])(
    'recusa %s (imutável)',
    (field) => {
      const result = documentTypeUpdateSchema.safeParse({ name: 'Ofício', [field]: 'X' });
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain(field);
    },
  );
});

describe('documentTypeListQuerySchema (DTY-01)', () => {
  it('converte includeInactive e a lista de kind', () => {
    expect(
      documentTypeListQuerySchema.parse({ includeInactive: 'true', kind: 'FREE_TEXT,UPLOADED' }),
    ).toEqual({ includeInactive: true, kind: ['FREE_TEXT', 'UPLOADED'] });
    expect(documentTypeListQuerySchema.parse({})).toEqual({});
  });

  it('recusa natureza desconhecida', () => {
    expect(documentTypeListQuerySchema.safeParse({ kind: 'OUTRA' }).success).toBe(false);
  });
});

describe('DocumentTypeChanged (events.md §4)', () => {
  it('usa a routing key document_type.changed e valida o payload', () => {
    const draft = DocumentTypeChanged.of({
      aggregateId: USER,
      payload: { documentTypeId: USER, code: 'OFICIO', changedFields: ['name'] },
    });
    expect(draft.definition.resolve(draft.payload)).toMatchObject({
      eventType: 'DocumentTypeChanged',
      aggregateType: 'DocumentType',
      routingKey: 'document_type.changed',
    });
    expect(() => DocumentTypeChanged.resolve({ documentTypeId: 'x', code: 'A' })).toThrow();
  });
});
