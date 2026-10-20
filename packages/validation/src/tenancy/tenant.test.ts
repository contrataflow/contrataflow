import { describe, expect, it } from 'vitest';

import {
  maskEmail,
  provisionTenantSchema,
  suggestTenantSlug,
  tenantListQuerySchema,
  tenantReasonSchema,
  tenantSlugSchema,
} from './tenant.js';
import { isValidCnpj, normalizeCnpj } from '../common/cnpj.js';

const valid = {
  slug: 'sao-jose',
  name: 'Prefeitura de São José',
  type: 'MUNICIPALITY',
  stateCode: 'SC',
  ibgeCityCode: '4216602',
  primaryOrganization: {
    name: 'Prefeitura Municipal de São José',
    shortName: 'pmsj',
    cnpj: '11.222.333/0001-81',
    type: 'DIRECT_ADMINISTRATION',
  },
  firstAdmin: { email: 'Rafael.Nogueira@PMSJ.exemplo.gov.br', name: 'Rafael Nogueira' },
};

/** `params.code` dos issues customizados (o código de campo da API — api.md §2.1.1). */
function codesOf(input: unknown): Record<string, string> {
  const result = provisionTenantSchema.safeParse(input);
  if (result.success) return {};
  return Object.fromEntries(
    result.error.issues.map((issue) => [
      issue.path.join('.'),
      issue.code === 'custom' ? String((issue.params as { code?: string }).code) : issue.code,
    ]),
  );
}

describe('CNPJ (RN-TEN-04 · V-06)', () => {
  it.each(['11.222.333/0001-81', '11222333000181', '12.ABC.345/01DE-35'])('%s é válido', (cnpj) => {
    expect(isValidCnpj(cnpj)).toBe(true);
  });

  it.each(['11.222.333/0001-82', '00000000000000', '1122233300018', 'AB.CDE.FGH/IJKL-MN', ''])(
    '%s é inválido',
    (cnpj) => {
      expect(isValidCnpj(cnpj)).toBe(false);
    },
  );

  it('normaliza máscara e caixa', () => {
    expect(normalizeCnpj('12.abc.345/01de-35')).toBe('12ABC34501DE35');
  });
});

describe('slug do tenant (RN-TEN-01)', () => {
  it.each(['sao-jose', 'abc', 'pmsj2026', 'a'.repeat(63)])('aceita %s', (slug) => {
    expect(tenantSlugSchema.safeParse(slug).success).toBe(true);
  });

  it.each([
    ['São José', 'custom'],
    ['-sao', 'custom'],
    ['sao--jose', 'custom'],
    ['sao-', 'custom'],
    ['Sao', 'custom'],
    ['admin', 'custom'],
    ['homolog', 'custom'],
    ['ab', 'too_small'],
    ['a'.repeat(64), 'too_big'],
  ])('recusa %s', (slug, code) => {
    const result = tenantSlugSchema.safeParse(slug);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe(code);
  });

  it('sugere slug a partir do nome', () => {
    expect(suggestTenantSlug('Prefeitura de São José')).toBe('prefeitura-de-sao-jose');
    expect(suggestTenantSlug('  Câmara  Municipal!  ')).toBe('camara-municipal');
  });
});

describe('provisionTenantSchema (RN-TEN-01..04)', () => {
  it('aplica padrões e normaliza e-mail, sigla e CNPJ', () => {
    const parsed = provisionTenantSchema.parse(valid);
    expect(parsed).toMatchObject({
      timezone: 'America/Sao_Paulo',
      locale: 'pt-BR',
      plan: 'STANDARD',
      activate: true,
      primaryOrganization: { shortName: 'PMSJ', cnpj: '11222333000181' },
      firstAdmin: { email: 'rafael.nogueira@pmsj.exemplo.gov.br' },
    });
  });

  it('[Validação] slug, CNPJ e fuso inválidos de uma vez (Gherkin)', () => {
    expect(
      codesOf({
        ...valid,
        slug: 'São José',
        timezone: 'Europe/Lisbon',
        primaryOrganization: { ...valid.primaryOrganization, cnpj: '11.222.333/0001-82' },
      }),
    ).toEqual({
      slug: 'INVALID_FORMAT',
      timezone: 'invalid_value',
      'primaryOrganization.cnpj': 'INVALID_CNPJ',
    });
  });

  it('IBGE obrigatório para município e câmara (V-05)', () => {
    const { ibgeCityCode: _omitted, ...withoutIbge } = valid;
    expect(codesOf(withoutIbge)).toEqual({ ibgeCityCode: 'CONDITIONAL_REQUIRED' });
    expect(codesOf({ ...withoutIbge, type: 'CITY_COUNCIL' })).toEqual({
      ibgeCityCode: 'CONDITIONAL_REQUIRED',
    });
    expect(provisionTenantSchema.safeParse({ ...withoutIbge, type: 'AUTARCHY' }).success).toBe(
      true,
    );
  });

  it('IBGE com prefixo de outra UF ou fora do formato (V-05)', () => {
    expect(codesOf({ ...valid, ibgeCityCode: '3550308' })).toEqual({
      ibgeCityCode: 'INVALID_FORMAT',
    });
    expect(codesOf({ ...valid, ibgeCityCode: '42166' })).toEqual({
      ibgeCityCode: 'INVALID_FORMAT',
    });
  });

  it('recusa UF, tipo, plano e e-mail fora da lista (V-04 · V-07)', () => {
    expect(
      codesOf({
        ...valid,
        stateCode: 'XX',
        type: 'STATE',
        plan: 'PREMIUM',
        firstAdmin: { email: 'sem-arroba', name: 'Rafael' },
      }),
    ).toMatchObject({
      stateCode: 'invalid_value',
      type: 'invalid_value',
      plan: 'invalid_value',
      'firstAdmin.email': 'invalid_format',
    });
  });

  it('aceita todos os fusos da allowlist brasileira', () => {
    for (const timezone of ['America/Manaus', 'America/Noronha', 'America/Rio_Branco']) {
      expect(provisionTenantSchema.safeParse({ ...valid, timezone }).success).toBe(true);
    }
  });
});

describe('motivo, listagem e máscara', () => {
  it('motivo obrigatório entre 10 e 1.000 caracteres (V-09)', () => {
    expect(tenantReasonSchema.safeParse({}).success).toBe(false);
    expect(tenantReasonSchema.safeParse({ reason: 'curto' }).success).toBe(false);
    expect(tenantReasonSchema.safeParse({ reason: 'x'.repeat(1001) }).success).toBe(false);
    expect(tenantReasonSchema.parse({ reason: '  Contrato com pagamento em atraso ' })).toEqual({
      reason: 'Contrato com pagamento em atraso',
    });
  });

  it('filtros de PLT-02 com paginação padrão', () => {
    expect(tenantListQuerySchema.parse({ status: 'ACTIVE' })).toEqual({
      status: 'ACTIVE',
      page: 1,
      pageSize: 20,
    });
    expect(tenantListQuerySchema.safeParse({ status: 'ATIVO' }).success).toBe(false);
  });

  it('mascara o e-mail do administrador', () => {
    expect(maskEmail('rafael.nogueira@pmsj.exemplo.gov.br')).toBe('r***@pmsj.exemplo.gov.br');
    expect(maskEmail('invalido')).toBe('***');
  });
});
