import type { ApprovalPolicy, DocumentTypeDto } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  buildCreateBody,
  buildPatch,
  EMPTY_VALUES,
  formFieldOf,
  initialValues,
  isEditablePolicy,
  suggestedCode,
  validateCreate,
  validatePatch,
} from './document-type-form-model';
import type { FormValues } from './document-type-form-model';

const MASK_ERROR = 'máscara inválida';
const USER = '0192a000-0000-7000-8000-0000000000a1';

const valid: FormValues = {
  ...EMPTY_VALUES,
  name: 'Parecer técnico',
  code: 'PARECER_TECNICO',
  numberingMask: 'PT {seq:3}/{year}',
};

function dto(overrides: Partial<DocumentTypeDto> = {}): DocumentTypeDto {
  return {
    id: '0192a000-0000-7000-8000-000000000001',
    code: 'OFICIO',
    name: 'Ofício',
    description: null,
    kind: 'FREE_TEXT',
    systemModule: null,
    isSystem: true,
    isActive: true,
    allowMultiplePerProcess: true,
    numberingEnabled: true,
    numberingMask: 'OF {seq:4}/{year}',
    nextNumberPreview: 'OF 0001/2026',
    requiresApproval: false,
    approvalPolicy: null,
    defaultConfidentiality: 'INTERNAL',
    defaultTemplate: null,
    sortOrder: 70,
    editableFields: [
      'name',
      'description',
      'numberingEnabled',
      'numberingMask',
      'requiresApproval',
      'approvalPolicy',
      'defaultConfidentiality',
      'sortOrder',
      'isActive',
    ],
    version: 3,
    ...overrides,
  };
}

describe('buildCreateBody / validateCreate (V-01, V-02, V-06, V-07, V-11)', () => {
  it('monta o corpo mínimo do DTY-02 sem campos vazios', () => {
    expect(buildCreateBody({ ...valid, numberingMask: '', description: '  ' })).toEqual({
      kind: 'FREE_TEXT',
      code: 'PARECER_TECNICO',
      name: 'Parecer técnico',
      allowMultiplePerProcess: true,
      numberingEnabled: true,
      requiresApproval: false,
      defaultConfidentiality: 'INTERNAL',
      sortOrder: 0,
    });
  });

  it('com a numeração desligada a máscara não vai', () => {
    expect(buildCreateBody({ ...valid, numberingEnabled: false })).not.toHaveProperty(
      'numberingMask',
    );
  });

  it('valores válidos não geram mensagens', () => {
    expect(validateCreate(valid, MASK_ERROR)).toEqual({});
  });

  it('nome curto, código fora do formato, máscara sem o ano e prazo fora de 1–365', () => {
    const messages = validateCreate(
      {
        ...valid,
        name: 'ab',
        code: 'parecer',
        numberingMask: 'PT {seq:3}',
        requiresApproval: true,
        slaDays: '400',
      },
      MASK_ERROR,
    );
    expect(messages.name).toBeTruthy();
    expect(messages).toMatchObject({
      code: 'Use letras maiúsculas, números e _ (ex.: PARECER_TECNICO).',
      numberingMask: MASK_ERROR,
      slaDays: 'O prazo deve estar entre 1 e 365 dias.',
    });
  });

  it('aprovação avulsa monta a política do titular da unidade solicitante', () => {
    expect(
      buildCreateBody({
        ...valid,
        requiresApproval: true,
        approverResolution: 'REQUESTING_DEPARTMENT',
        allowDeputy: false,
        slaDays: '3',
        slaType: 'CALENDAR',
      }),
    ).toMatchObject({
      requiresApproval: true,
      approvalPolicy: {
        approverType: 'DEPARTMENT_HEAD',
        approverDepartmentResolution: 'REQUESTING_DEPARTMENT',
        allowDeputy: false,
        slaDays: 3,
        slaType: 'CALENDAR',
      },
    });
  });
});

describe('buildPatch (RN-DOC-03)', () => {
  it('só os campos alterados e permitidos pelo tipo', () => {
    const type = dto();
    const values = { ...initialValues(type), name: 'Ofício externo', numberingMask: '' };
    expect(buildPatch(values, { name: true, numberingMask: true }, type)).toEqual({
      name: 'Ofício externo',
      numberingMask: null,
    });
  });

  it('campo restrito do tipo nunca vai, mesmo alterado', () => {
    const type = dto();
    const values = { ...initialValues(type), allowMultiplePerProcess: false };
    expect(buildPatch(values, { allowMultiplePerProcess: true }, type)).toEqual({});
  });

  it('liga a aprovação com a política; desligar não reenvia a política', () => {
    const type = dto();
    const on = { ...initialValues(type), requiresApproval: true };
    expect(buildPatch(on, { requiresApproval: true }, type)).toEqual({
      requiresApproval: true,
      approvalPolicy: {
        approverType: 'DEPARTMENT_HEAD',
        approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
        allowDeputy: true,
      },
    });
    const off = { ...initialValues(type), requiresApproval: false };
    expect(buildPatch(off, { requiresApproval: true }, type)).toEqual({ requiresApproval: false });
  });

  it('política com aprovador específico é preservada: nada dela é reenviado', () => {
    const policy: ApprovalPolicy = {
      approverType: 'USER',
      approverUserId: USER,
      allowDeputy: true,
    };
    const type = dto({ requiresApproval: true, approvalPolicy: policy });
    const values = { ...initialValues(type), allowDeputy: false };
    expect(isEditablePolicy(policy)).toBe(false);
    expect(buildPatch(values, { allowDeputy: true }, type)).toEqual({});
  });

  it('validatePatch confere máscara e prazo', () => {
    const type = dto();
    const values = {
      ...initialValues(type),
      numberingMask: 'OF {seq:4}',
      requiresApproval: true,
      slaDays: '0',
    };
    const patch = buildPatch(
      values,
      { numberingMask: true, requiresApproval: true, slaDays: true },
      type,
    );
    expect(validatePatch(values, patch, MASK_ERROR)).toMatchObject({
      numberingMask: MASK_ERROR,
      slaDays: 'O prazo deve estar entre 1 e 365 dias.',
    });
  });
});

describe('utilitários', () => {
  it('suggestedCode e formFieldOf', () => {
    expect(suggestedCode('Parecer técnico')).toBe('PARECER_TECNICO');
    expect(formFieldOf('approvalPolicy.approverDepartmentResolution')).toBe('approverResolution');
    expect(formFieldOf('approvalPolicy.approverUserId')).toBe('requiresApproval');
    expect(formFieldOf('approvalPolicy.slaDays')).toBe('slaDays');
    expect(formFieldOf('code')).toBe('code');
    expect(formFieldOf('isActive')).toBeNull();
  });

  it('initialValues do tipo existente traz a política editável', () => {
    const values = initialValues(
      dto({
        requiresApproval: true,
        approvalPolicy: {
          approverType: 'DEPARTMENT_HEAD',
          approverDepartmentResolution: 'REQUESTING_DEPARTMENT',
          allowDeputy: false,
          slaDays: 5,
          slaType: 'CALENDAR',
        },
      }),
    );
    expect(values).toMatchObject({
      approverResolution: 'REQUESTING_DEPARTMENT',
      allowDeputy: false,
      slaDays: '5',
      slaType: 'CALENDAR',
      numberingMask: 'OF {seq:4}/{year}',
    });
  });
});
