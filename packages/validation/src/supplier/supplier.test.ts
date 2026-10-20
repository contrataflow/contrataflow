import { describe, expect, it } from 'vitest';

import { SupplierCreated, SupplierUpdated } from './events.js';
import {
  createSupplierSchema,
  displaySupplierDocument,
  normalizeSupplierDocument,
  supplierDocumentIssue,
  supplierListQuerySchema,
  supplierLookupQuerySchema,
  updateSupplierSchema,
} from './supplier.js';
import { isValidCnpj } from '../common/cnpj.js';
import { isValidCpf, maskCpf, normalizeCpf } from '../common/cpf.js';

const valid = {
  documentType: 'CNPJ',
  documentNumber: '11.222.333/0001-81',
  legalName: 'Construtora ABC Ltda',
};

function issuesOf(result: { error?: { issues: { path: PropertyKey[]; params?: unknown }[] } }) {
  return (result.error?.issues ?? []).map((issue) => ({
    path: issue.path.join('.'),
    code: (issue.params as { code?: string } | undefined)?.code,
  }));
}

describe('CPF (RN-PRICE-16)', () => {
  it('valida o dígito verificador e rejeita sequências repetidas', () => {
    expect(isValidCpf('111.444.777-35')).toBe(true);
    expect(isValidCpf('11144477735')).toBe(true);
    expect(isValidCpf('111.444.777-36')).toBe(false);
    expect(isValidCpf('111.111.111-11')).toBe(false);
    expect(isValidCpf('1114447773')).toBe(false);
    expect(isValidCpf('abc.def.ghi-jk')).toBe(false);
  });

  it('normaliza e mascara', () => {
    expect(normalizeCpf(' 111.444.777-35 '.trim())).toBe('11144477735');
    expect(maskCpf('11144477735')).toBe('***.444.777-**');
    expect(maskCpf('111.444.777-35')).toBe('***.444.777-**');
    expect(maskCpf('123')).toBe('123');
  });
});

describe('CNPJ numérico e alfanumérico (RN-PRICE-15)', () => {
  it.each([
    ['11.222.333/0001-81', true],
    ['11222333000181', true],
    ['12.ABC.345/01DE-35', true],
    ['12abc34501de35', true],
    ['11.222.333/0001-00', false],
    ['12.ABC.345/01DE-36', false],
    ['00000000000000', false],
    ['12.ABC.345/01DE', false],
  ])('%s → %s', (value, expected) => {
    expect(isValidCnpj(value)).toBe(expected);
  });
});

describe('documento do fornecedor', () => {
  it('normaliza por tipo e exibe o CPF mascarado', () => {
    expect(normalizeSupplierDocument('CNPJ', '12.abc.345/01de-35')).toBe('12ABC34501DE35');
    expect(normalizeSupplierDocument('CPF', '111.444.777-35')).toBe('11144477735');
    expect(normalizeSupplierDocument('FOREIGN', '  AB   123 ')).toBe('AB 123');
    expect(displaySupplierDocument('CPF', '11144477735')).toBe('***.444.777-**');
    expect(displaySupplierDocument('CNPJ', '11222333000181')).toBe('11222333000181');
    expect(displaySupplierDocument('FOREIGN', 'AB 123')).toBe('AB 123');
  });

  it('aponta o erro do tipo', () => {
    expect(supplierDocumentIssue('CNPJ', '11222333000100')?.code).toBe('INVALID_CNPJ');
    expect(supplierDocumentIssue('CPF', '11144477700')?.code).toBe('INVALID_CPF');
    expect(supplierDocumentIssue('FOREIGN', 'X'.repeat(21))?.code).toBe('TOO_LONG');
    expect(supplierDocumentIssue('FOREIGN', 'X'.repeat(20))).toBeNull();
    expect(supplierDocumentIssue('CNPJ', '11222333000181')).toBeNull();
  });
});

describe('createSupplierSchema (SUP-02 · RN-PRICE-14)', () => {
  it('aceita CNPJ numérico, alfanumérico, CPF e estrangeiro', () => {
    expect(createSupplierSchema.safeParse(valid).success).toBe(true);
    expect(
      createSupplierSchema.safeParse({ ...valid, documentNumber: '12.ABC.345/01DE-35' }).success,
    ).toBe(true);
    expect(
      createSupplierSchema.safeParse({
        documentType: 'CPF',
        documentNumber: '111.444.777-35',
        legalName: 'João da Silva',
      }).success,
    ).toBe(true);
    expect(
      createSupplierSchema.safeParse({
        documentType: 'FOREIGN',
        documentNumber: 'DE-123456789',
        legalName: 'Acme GmbH',
      }).success,
    ).toBe(true);
  });

  it('normaliza campos de texto, e-mail e CEP', () => {
    const parsed = createSupplierSchema.parse({
      ...valid,
      legalName: '  Construtora ABC Ltda  ',
      email: ' Contato@ABC.com.br ',
      addressState: 'sc',
      addressZipCode: '88.100-000',
      website: 'https://abc.com.br',
      isActive: false,
    });
    expect(parsed).toMatchObject({
      legalName: 'Construtora ABC Ltda',
      email: 'contato@abc.com.br',
      addressState: 'SC',
      addressZipCode: '88100000',
    });
    expect(parsed).not.toHaveProperty('isActive');
  });

  it('V-01: obrigatórios', () => {
    expect(issuesOf(createSupplierSchema.safeParse({})).map((issue) => issue.path)).toEqual(
      expect.arrayContaining(['documentType', 'documentNumber', 'legalName']),
    );
  });

  it('V-02/V-03: dígito verificador inválido no campo documentNumber', () => {
    expect(
      issuesOf(createSupplierSchema.safeParse({ ...valid, documentNumber: '11.222.333/0001-00' })),
    ).toEqual([{ path: 'documentNumber', code: 'INVALID_CNPJ' }]);
    expect(
      issuesOf(
        createSupplierSchema.safeParse({
          ...valid,
          documentType: 'CPF',
          documentNumber: '111.444.777-00',
        }),
      ),
    ).toEqual([{ path: 'documentNumber', code: 'INVALID_CPF' }]);
  });

  it('CNPJ no tipo CPF (e vice-versa) é inválido', () => {
    expect(createSupplierSchema.safeParse({ ...valid, documentType: 'CPF' }).success).toBe(false);
  });

  it('V-05/V-06: e-mail, website e limites', () => {
    const paths = (extra: Record<string, unknown>) =>
      issuesOf(createSupplierSchema.safeParse({ ...valid, ...extra })).map((issue) => issue.path);
    expect(paths({ email: 'sem-arroba' })).toEqual(['email']);
    expect(paths({ website: 'abc' })).toEqual(['website']);
    expect(paths({ website: 'ftp://abc.com' })).toEqual(['website']);
    expect(paths({ legalName: 'A' })).toEqual(['legalName']);
    expect(paths({ legalName: 'A'.repeat(251) })).toEqual(['legalName']);
    expect(paths({ tradeName: 'A'.repeat(251) })).toEqual(['tradeName']);
    expect(paths({ notes: 'A'.repeat(5_001) })).toEqual(['notes']);
    expect(paths({ phone: '1'.repeat(21) })).toEqual(['phone']);
    expect(paths({ documentType: 'PJ' })).toEqual(['documentType']);
  });
});

describe('updateSupplierSchema (SUP-04)', () => {
  it('campos opcionais, null limpa e isActive inativa', () => {
    expect(updateSupplierSchema.parse({ tradeName: null, isActive: false })).toEqual({
      tradeName: null,
      isActive: false,
    });
    expect(updateSupplierSchema.parse({})).toEqual({});
  });
});

describe('consultas', () => {
  it('SUP-01: q com mínimo de 2 caracteres e isActive booleano', () => {
    expect(supplierListQuerySchema.safeParse({ q: 'a' }).success).toBe(false);
    expect(supplierListQuerySchema.parse({ q: 'abc', isActive: 'false' })).toMatchObject({
      q: 'abc',
      isActive: false,
      page: 1,
      pageSize: 20,
    });
  });

  it('SUP-06: documentNumber obrigatório', () => {
    expect(supplierLookupQuerySchema.safeParse({}).success).toBe(false);
    expect(supplierLookupQuerySchema.parse({ documentNumber: ' 11.222.333/0001-81 ' })).toEqual({
      documentNumber: '11.222.333/0001-81',
    });
  });
});

describe('eventos Supplier* (events.md §4.5)', () => {
  const supplierId = '0192a000-0000-7000-8000-0000000100a1';

  it('routing keys e payloads (só IDs, tipo e campos alterados)', () => {
    expect(SupplierCreated.resolve({ supplierId, documentType: 'CPF' }).routingKey).toBe(
      'supplier.created',
    );
    expect(
      SupplierUpdated.resolve({ supplierId, documentType: 'CNPJ', changedFields: ['legalName'] })
        .payload,
    ).toEqual({ supplierId, documentType: 'CNPJ', changedFields: ['legalName'] });
    expect(() =>
      SupplierCreated.resolve({ supplierId, documentType: 'CPF', documentNumber: '1' }),
    ).toThrow(/SupplierCreated/);
  });
});
