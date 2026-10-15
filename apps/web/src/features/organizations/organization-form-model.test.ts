import type { OrganizationDto } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  buildCreateBody,
  buildPatch,
  emptyValues,
  formatCnpj,
  initialValues,
  validateCreate,
  validatePatch,
} from './organization-form-model';

const required = (field: string) => `Informe o campo ${field}.`;

const ORG: OrganizationDto = {
  id: '0192a000-0000-7000-8000-000000000101',
  name: 'Fundo Municipal de Saúde',
  shortName: 'FMS',
  cnpj: '11444777000161',
  type: 'FUND',
  isActive: true,
  isPrimary: false,
  email: 'fms@saude.gov.br',
  phone: null,
  website: null,
  addressStreet: null,
  addressNumber: null,
  addressComplement: null,
  addressDistrict: null,
  addressCity: 'São José',
  addressState: 'SC',
  addressZipCode: '88100000',
  ibgeCityCode: null,
  logoAttachmentId: null,
  metadata: {},
  createdAt: '2026-10-15T12:00:00.000Z',
  updatedAt: '2026-10-15T12:00:00.000Z',
  version: 3,
};

describe('formatCnpj (CnpjInput)', () => {
  it('aplica a máscara progressivamente', () => {
    expect(formatCnpj('1')).toBe('1');
    expect(formatCnpj('112')).toBe('11.2');
    expect(formatCnpj('11222333')).toBe('11.222.333');
    expect(formatCnpj('112223330001')).toBe('11.222.333/0001');
    expect(formatCnpj('11222333000181')).toBe('11.222.333/0001-81');
  });

  it('aceita o CNPJ alfanumérico, em maiúsculas', () => {
    expect(formatCnpj('12abc34501de35')).toBe('12.ABC.345/01DE-35');
  });

  it('descarta o que passa de 14 posições e tira a máscara já digitada', () => {
    expect(formatCnpj('11.222.333/0001-81999')).toBe('11.222.333/0001-81');
    expect(formatCnpj('')).toBe('');
  });
});

describe('initialValues / buildCreateBody', () => {
  it('formulário vazio: obrigatórios em branco e ativo', () => {
    expect(emptyValues()).toMatchObject({ name: '', cnpj: '', type: '', isActive: true });
  });

  it('o corpo da criação omite os opcionais vazios', () => {
    const body = buildCreateBody({
      ...emptyValues(),
      name: 'Fundo',
      shortName: 'fms',
      cnpj: '11.444.777/0001-61',
      type: 'FUND',
      email: ' ',
      website: 'https://x.gov.br',
    });
    expect(body).toEqual({
      name: 'Fundo',
      shortName: 'fms',
      cnpj: '11.444.777/0001-61',
      type: 'FUND',
      website: 'https://x.gov.br',
    });
  });

  it('o órgão carregado vira valores de formulário com o CNPJ mascarado', () => {
    expect(initialValues(ORG)).toMatchObject({
      cnpj: '11.444.777/0001-61',
      email: 'fms@saude.gov.br',
      phone: '',
      addressZipCode: '88100000',
    });
  });
});

describe('validateCreate (V-01..V-05 com os schemas da API)', () => {
  it('obrigatórios vazios: "Informe o campo …"', () => {
    const problems = validateCreate(emptyValues(), required);
    expect(problems).toMatchObject({
      name: 'Informe o campo name.',
      shortName: 'Informe o campo shortName.',
      cnpj: 'Informe o campo cnpj.',
      type: 'Informe o campo type.',
    });
  });

  it('CNPJ com dígito verificador inválido: V-03', () => {
    const problems = validateCreate(
      {
        ...emptyValues(),
        name: 'Fundo Municipal',
        shortName: 'FMS',
        cnpj: '11.111.111/1111-00',
        type: 'FUND',
      },
      required,
    );
    expect(problems).toEqual({ cnpj: 'CNPJ inválido. Confira os dígitos verificadores.' });
  });

  it('sigla fora do padrão (V-02) e site sem https (V-05)', () => {
    const problems = validateCreate(
      {
        ...emptyValues(),
        name: 'Fundo Municipal',
        shortName: 'F M S',
        cnpj: '11.444.777/0001-61',
        type: 'FUND',
        website: 'http://x.gov.br',
      },
      required,
    );
    expect(Object.keys(problems).sort()).toEqual(['shortName', 'website']);
    expect(problems.website).toBe('Informe um endereço começando com https://.');
  });

  it('dados válidos: nenhum problema', () => {
    expect(
      validateCreate(
        {
          ...emptyValues(),
          name: 'Fundo Municipal',
          shortName: 'fms',
          cnpj: '11.444.777/0001-61',
          type: 'FUND',
          addressState: 'sc',
          addressZipCode: '88.100-000',
        },
        required,
      ),
    ).toEqual({});
  });
});

describe('buildPatch (ORG-04: só o que mudou)', () => {
  it('sem mudança: corpo vazio (mesmo com sigla/CNPJ em formatos equivalentes)', () => {
    const same = { ...initialValues(ORG), shortName: 'fms', cnpj: '11444777000161' };
    expect(buildPatch(same, ORG)).toEqual({});
  });

  it('envia só os campos alterados; opcional esvaziado vira null; isActive só se mudou', () => {
    const edited = {
      ...initialValues(ORG),
      name: 'Fundo Municipal de Saúde de São José',
      email: '',
      phone: '4833810000',
      isActive: false,
    };
    expect(buildPatch(edited, ORG)).toEqual({
      name: 'Fundo Municipal de Saúde de São José',
      email: null,
      phone: '4833810000',
      isActive: false,
    });
  });

  it('validatePatch confere só o que vai no corpo', () => {
    expect(validatePatch({ cnpj: '123' }, required).cnpj).toBeDefined();
    expect(validatePatch({ name: '   ' }, required).name).toBe('Informe o campo name.');
    expect(validatePatch({ phone: null, isActive: false }, required)).toEqual({});
  });
});
