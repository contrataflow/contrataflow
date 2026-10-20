import type { SupplierDto } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  buildCreateBody,
  buildPatch,
  displayDocument,
  documentProblem,
  emptyValues,
  formatCnpj,
  formatCpf,
  formatDocument,
  initialValues,
  isDocumentComplete,
  validateCreate,
  validatePatch,
} from './supplier-form-model';

const required = (field: string) => `Informe o campo ${field}.`;

function supplier(overrides: Partial<SupplierDto> = {}): SupplierDto {
  return {
    id: '0192a000-0000-7000-8000-000000000001',
    documentType: 'CNPJ',
    documentNumber: '11222333000181',
    legalName: 'Construtora ABC Ltda',
    tradeName: null,
    email: null,
    phone: null,
    website: null,
    contactName: null,
    addressStreet: null,
    addressNumber: null,
    addressComplement: null,
    addressDistrict: null,
    addressCity: null,
    addressState: null,
    addressZipCode: null,
    isActive: true,
    notes: null,
    createdAt: '2026-10-16T12:00:00.000Z',
    updatedAt: '2026-10-16T12:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

describe('máscara do documento (RN-PRICE-15/16/18)', () => {
  it('CNPJ numérico e alfanumérico, progressivo e em maiúsculas', () => {
    expect(formatCnpj('11')).toBe('11');
    expect(formatCnpj('11222')).toBe('11.222');
    expect(formatCnpj('11222333000181')).toBe('11.222.333/0001-81');
    expect(formatCnpj('12abc34501de35')).toBe('12.ABC.345/01DE-35');
    expect(formatCnpj('11.222.333/0001-81999')).toBe('11.222.333/0001-81');
  });

  it('CPF só com dígitos', () => {
    expect(formatCpf('111')).toBe('111');
    expect(formatCpf('11144')).toBe('111.44');
    expect(formatCpf('11144477735')).toBe('111.444.777-35');
    expect(formatCpf('111.444.777-35xx')).toBe('111.444.777-35');
  });

  it('estrangeiro livre, até 20 caracteres', () => {
    expect(formatDocument('FOREIGN', 'DE-123456789')).toBe('DE-123456789');
    expect(formatDocument('FOREIGN', 'X'.repeat(25))).toHaveLength(20);
    expect(formatDocument('CPF', '11144477735')).toBe('111.444.777-35');
    expect(formatDocument('CNPJ', '11222333000181')).toBe('11.222.333/0001-81');
  });
});

describe('conferência do documento (V-02/V-03)', () => {
  it('só confere com o número completo do tipo', () => {
    expect(isDocumentComplete('CNPJ', '11.222.333/0001')).toBe(false);
    expect(isDocumentComplete('CNPJ', '11.222.333/0001-81')).toBe(true);
    expect(isDocumentComplete('CPF', '111.444.777-3')).toBe(false);
    expect(isDocumentComplete('CPF', '111.444.777-35')).toBe(true);
    expect(isDocumentComplete('FOREIGN', '  ')).toBe(false);
    expect(isDocumentComplete('FOREIGN', 'AB')).toBe(true);
  });

  it('dígito verificador de CNPJ (numérico e alfanumérico) e de CPF', () => {
    expect(documentProblem('CNPJ', '11.222.333/0001-81')).toBeNull();
    expect(documentProblem('CNPJ', '12.ABC.345/01DE-35')).toBeNull();
    expect(documentProblem('CNPJ', '11.222.333/0001-00')).toBe('INVALID_CNPJ');
    expect(documentProblem('CPF', '111.444.777-35')).toBeNull();
    expect(documentProblem('CPF', '111.444.777-00')).toBe('INVALID_CPF');
    expect(documentProblem('FOREIGN', 'DE-123')).toBeNull();
  });
});

describe('valores iniciais e exibição', () => {
  it('formulário vazio é CNPJ ativo', () => {
    expect(emptyValues()).toMatchObject({
      documentType: 'CNPJ',
      documentNumber: '',
      isActive: true,
    });
  });

  it('CNPJ ganha máscara; CPF e estrangeiro ficam como a API devolve', () => {
    expect(initialValues(supplier()).documentNumber).toBe('11.222.333/0001-81');
    expect(
      initialValues(supplier({ documentType: 'CPF', documentNumber: '***.444.777-**' }))
        .documentNumber,
    ).toBe('***.444.777-**');
    expect(
      initialValues(supplier({ documentType: 'FOREIGN', documentNumber: 'DE-123' })).documentNumber,
    ).toBe('DE-123');
  });

  it('exibe o documento por tipo (CPF nunca em claro)', () => {
    expect(displayDocument(supplier())).toBe('11.222.333/0001-81');
    expect(displayDocument({ documentType: 'CPF', documentNumber: '***.444.777-**' })).toBe(
      '***.444.777-**',
    );
    expect(displayDocument({ documentType: 'FOREIGN', documentNumber: 'DE-123' })).toBe('DE-123');
  });
});

describe('corpo de SUP-02', () => {
  it('opcionais vazios saem do corpo; documento vai como digitado', () => {
    const body = buildCreateBody({
      ...emptyValues(),
      documentNumber: '11.222.333/0001-81',
      legalName: 'Construtora ABC Ltda',
      email: ' contato@abc.com.br ',
    });
    expect(body).toEqual({
      documentType: 'CNPJ',
      documentNumber: '11.222.333/0001-81',
      legalName: 'Construtora ABC Ltda',
      email: 'contato@abc.com.br',
    });
  });

  it('V-01: obrigatórios vazios; e-mail e website inválidos vêm do Zod', () => {
    const problems = validateCreate(emptyValues(), required);
    expect(problems).toMatchObject({
      documentNumber: 'Informe o campo documentNumber.',
      legalName: 'Informe o campo legalName.',
    });
    const invalid = validateCreate(
      {
        ...emptyValues(),
        documentNumber: '11.222.333/0001-81',
        legalName: 'ABC Ltda',
        email: 'sem-arroba',
        website: 'abc',
      },
      required,
    );
    expect(Object.keys(invalid).sort()).toEqual(['email', 'website']);
  });

  it('V-02/V-03: dígito verificador inválido no Zod compartilhado', () => {
    expect(
      validateCreate(
        { ...emptyValues(), documentNumber: '11.222.333/0001-00', legalName: 'ABC Ltda' },
        required,
      ).documentNumber,
    ).toBe('CNPJ inválido. Verifique o número digitado.');
    expect(
      validateCreate(
        {
          ...emptyValues(),
          documentType: 'CPF',
          documentNumber: '111.444.777-00',
          legalName: 'João',
        },
        required,
      ).documentNumber,
    ).toBe('CPF inválido. Verifique o número digitado.');
  });
});

describe('corpo de SUP-04', () => {
  const base = supplier({ tradeName: 'ABC', phone: '4833' });

  it('só o que mudou; esvaziado vai como null; o documento nunca entra', () => {
    const values = {
      ...initialValues(base),
      legalName: 'ABC Brasil Ltda',
      phone: '',
      email: 'novo@abc.com.br',
      documentNumber: '99.999.999/0001-99',
      documentType: 'CPF' as const,
    };
    expect(buildPatch(values, base)).toEqual({
      legalName: 'ABC Brasil Ltda',
      phone: null,
      email: 'novo@abc.com.br',
    });
  });

  it('sem mudança: corpo vazio; inativar envia isActive', () => {
    expect(buildPatch(initialValues(base), base)).toEqual({});
    expect(buildPatch({ ...initialValues(base), isActive: false }, base)).toEqual({
      isActive: false,
    });
  });

  it('valida só o que vai no corpo', () => {
    expect(validatePatch({ phone: null }, required)).toEqual({});
    expect(validatePatch({ email: 'x' }, required)).toHaveProperty('email');
    expect(validatePatch({ legalName: '  ' }, required).legalName).toBeDefined();
  });
});
