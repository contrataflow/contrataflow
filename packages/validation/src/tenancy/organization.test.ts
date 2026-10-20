import { describe, expect, it } from 'vitest';

import {
  createOrganizationSchema,
  organizationListQuerySchema,
  organizationSchema,
  updateOrganizationSchema,
} from './organization.js';

const valid = {
  name: 'Fundo Municipal de Saúde',
  shortName: 'fms',
  cnpj: '11.444.777/0001-61',
  type: 'FUND',
};

function issuesOf(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) {
  return (result.error?.issues ?? []).map((issue) => issue.path.join('.'));
}

describe('createOrganizationSchema (ORG-02 · RN-TEN-38..43)', () => {
  it('normaliza sigla (maiúsculas), CNPJ (sem máscara), e-mail, UF e CEP', () => {
    const parsed = createOrganizationSchema.parse({
      ...valid,
      name: '  Fundo Municipal de Saúde  ',
      email: ' FMS@Saude.GOV.br ',
      addressState: 'sc',
      addressZipCode: '88.100-000',
    });
    expect(parsed).toMatchObject({
      name: 'Fundo Municipal de Saúde',
      shortName: 'FMS',
      cnpj: '11444777000161',
      email: 'fms@saude.gov.br',
      addressState: 'SC',
      addressZipCode: '88100000',
    });
  });

  it('aceita CNPJ alfanumérico com DV válido', () => {
    expect(createOrganizationSchema.parse({ ...valid, cnpj: '12.ABC.345/01DE-35' }).cnpj).toBe(
      '12ABC34501DE35',
    );
  });

  it('obrigatórios: name, shortName, cnpj e type (RN-TEN-38)', () => {
    const result = createOrganizationSchema.safeParse({});
    expect(issuesOf(result).sort()).toEqual(['cnpj', 'name', 'shortName', 'type']);
  });

  it.each([
    ['sigla curta', { shortName: 'A' }, 'shortName'],
    ['sigla longa', { shortName: 'A'.repeat(31) }, 'shortName'],
    ['sigla com espaço', { shortName: 'AB CD' }, 'shortName'],
    ['sigla com acento', { shortName: 'SAÚDE' }, 'shortName'],
    ['nome curto', { name: 'AB' }, 'name'],
    ['nome longo', { name: 'A'.repeat(251) }, 'name'],
    ['CNPJ com DV inválido', { cnpj: '11.111.111/1111-00' }, 'cnpj'],
    ['CNPJ repetido (todos iguais)', { cnpj: '11111111111111' }, 'cnpj'],
    ['tipo fora do enum', { type: 'MINISTERIO' }, 'type'],
    ['e-mail inválido', { email: 'sem-arroba' }, 'email'],
    ['telefone longo', { phone: '1'.repeat(21) }, 'phone'],
    ['website http', { website: 'http://orgao.gov.br' }, 'website'],
    ['website sem host', { website: 'https://' }, 'website'],
    ['UF com 3 letras', { addressState: 'SCX' }, 'addressState'],
    ['CEP com 7 dígitos', { addressZipCode: '8810000' }, 'addressZipCode'],
    ['IBGE com 6 dígitos', { ibgeCityCode: '421660' }, 'ibgeCityCode'],
  ])('recusa %s', (_label, override, field) => {
    expect(issuesOf(createOrganizationSchema.safeParse({ ...valid, ...override }))).toEqual([
      field,
    ]);
  });

  it('INVALID_CNPJ é o código do campo cnpj com DV inválido (V-03)', () => {
    const result = createOrganizationSchema.safeParse({ ...valid, cnpj: '11.111.111/1111-00' });
    const issue = result.error?.issues[0];
    expect(issue).toMatchObject({ path: ['cnpj'], code: 'custom' });
    expect((issue as { params?: { code?: string } }).params?.code).toBe('INVALID_CNPJ');
  });

  it('descarta em silêncio metadata, isActive e logoAttachmentId enviados na criação (RN-TEN-43)', () => {
    const parsed = createOrganizationSchema.parse({
      ...valid,
      metadata: { pncp: 'x' },
      isActive: false,
      logoAttachmentId: '0192c000-0000-7000-8000-00000000a104',
    });
    expect(parsed).not.toHaveProperty('metadata');
    expect(parsed).not.toHaveProperty('isActive');
    expect(parsed).not.toHaveProperty('logoAttachmentId');
  });
});

describe('updateOrganizationSchema (ORG-04)', () => {
  it('todos os campos são opcionais; null limpa os opcionais', () => {
    expect(updateOrganizationSchema.parse({})).toEqual({});
    expect(updateOrganizationSchema.parse({ phone: null, logoAttachmentId: null })).toEqual({
      phone: null,
      logoAttachmentId: null,
    });
  });

  it('aceita isActive e logoAttachmentId; recusa null em campo obrigatório', () => {
    const logo = '0192c000-0000-7000-8000-00000000a104';
    expect(updateOrganizationSchema.parse({ isActive: false, logoAttachmentId: logo })).toEqual({
      isActive: false,
      logoAttachmentId: logo,
    });
    expect(updateOrganizationSchema.safeParse({ name: null }).success).toBe(false);
    expect(updateOrganizationSchema.safeParse({ cnpj: null }).success).toBe(false);
    expect(updateOrganizationSchema.safeParse({ isActive: 'sim' }).success).toBe(false);
  });

  it('as validações de formato são as da criação', () => {
    expect(updateOrganizationSchema.safeParse({ cnpj: '123' }).success).toBe(false);
    expect(updateOrganizationSchema.safeParse({ website: 'http://x.gov.br' }).success).toBe(false);
    expect(updateOrganizationSchema.safeParse({ shortName: 'ok-1' }).data).toEqual({
      shortName: 'OK-1',
    });
  });

  it('metadata enviado é ignorado', () => {
    expect(updateOrganizationSchema.parse({ metadata: { a: 1 } })).toEqual({});
  });
});

describe('organizationListQuerySchema (ORG-01)', () => {
  it('padrões de paginação e filtros opcionais', () => {
    expect(organizationListQuerySchema.parse({})).toMatchObject({ page: 1, pageSize: 20 });
    expect(organizationListQuerySchema.parse({ isActive: 'false', q: ' fms ' })).toMatchObject({
      isActive: false,
      q: 'fms',
    });
  });

  it('q com menos de 2 caracteres e isActive inválido são recusados', () => {
    expect(organizationListQuerySchema.safeParse({ q: 'a' }).success).toBe(false);
    expect(organizationListQuerySchema.safeParse({ isActive: 'talvez' }).success).toBe(false);
  });
});

describe('organizationSchema (resposta)', () => {
  it('descreve o recurso com metadata somente leitura', () => {
    const dto = {
      id: '0192c000-0000-7000-8000-00000000a103',
      name: 'Fundo',
      shortName: 'FMS',
      cnpj: '11444777000161',
      type: 'FUND',
      isActive: true,
      isPrimary: false,
      email: null,
      phone: null,
      website: null,
      addressStreet: null,
      addressNumber: null,
      addressComplement: null,
      addressDistrict: null,
      addressCity: null,
      addressState: null,
      addressZipCode: null,
      ibgeCityCode: null,
      logoAttachmentId: null,
      metadata: {},
      createdAt: '2026-10-15T12:00:00.000Z',
      updatedAt: '2026-10-15T12:00:00.000Z',
      version: 1,
    };
    expect(organizationSchema.parse(dto)).toEqual(dto);
  });
});
