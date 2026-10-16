import { describe, expect, it } from 'vitest';

import {
  isBrazilianPhone,
  isPreferenceKey,
  isPreferenceValue,
  PROFILE_NAME_MESSAGE,
  PROFILE_PHONE_MESSAGE,
  updateMyProfileSchema,
} from './profile.js';

describe('isBrazilianPhone (RN-IAM-109)', () => {
  it.each([
    '(11) 91234-5678',
    '11912345678',
    '11 3234-5678',
    '1132345678',
    '+55 (48) 99999-1234',
    '+5548999991234',
  ])('aceita %s', (phone) => {
    expect(isBrazilianPhone(phone)).toBe(true);
  });

  it.each([
    '12345',
    '(11) 81234-5678', // celular sem 9 inicial
    '(01) 91234-5678', // DDD inválido
    '+1 (415) 555-2671',
    '11 91234-567x',
    '11912345678901',
    '',
  ])('recusa %s', (phone) => {
    expect(isBrazilianPhone(phone)).toBe(false);
  });
});

describe('updateMyProfileSchema (ME-02)', () => {
  const messages = (body: unknown) => {
    const result = updateMyProfileSchema.safeParse(body);
    return result.success ? [] : result.error.issues.map((issue) => issue.message);
  };

  it('aceita corpo parcial, aplica trim e devolve só o que foi enviado', () => {
    expect(updateMyProfileSchema.parse({ name: '  Ana Souza  ' })).toEqual({ name: 'Ana Souza' });
    expect(updateMyProfileSchema.parse({})).toEqual({});
  });

  it('V-01: nome ausente/curto e telefone inválido usam as mensagens da story', () => {
    expect(messages({ name: 'A' })).toContain(PROFILE_NAME_MESSAGE);
    expect(messages({ name: '   ' })).toContain(PROFILE_NAME_MESSAGE);
    expect(messages({ phone: '123' })).toContain(PROFILE_PHONE_MESSAGE);
    expect(messages({ socialName: 'E' })).toContain(PROFILE_NAME_MESSAGE);
    expect(messages({ name: 'x'.repeat(201) })).toHaveLength(1);
  });

  it('FA-01: nome social e telefone vazios, só com espaços ou null viram null', () => {
    expect(updateMyProfileSchema.parse({ socialName: '', phone: '  ' })).toEqual({
      socialName: null,
      phone: null,
    });
    expect(updateMyProfileSchema.parse({ socialName: null })).toEqual({ socialName: null });
  });

  it('RN-IAM-109: campos fora de name/socialName/phone/preferences são recusados', () => {
    for (const field of ['email', 'cpfEncrypted', 'status', 'isPlatformOperator', 'jobTitle']) {
      expect(updateMyProfileSchema.safeParse({ [field]: 'x' }).success, field).toBe(false);
    }
  });

  it('preferences chega livre (a chave desconhecida é decidida pela API — RN-IAM-111)', () => {
    expect(updateMyProfileSchema.parse({ preferences: { theme: 'dark', outra: 1 } })).toEqual({
      preferences: { theme: 'dark', outra: 1 },
    });
  });
});

describe('registro de preferências (RN-IAM-111)', () => {
  it('reconhece só densidade e tema, com os valores do registro', () => {
    expect(isPreferenceKey('density')).toBe(true);
    expect(isPreferenceKey('theme')).toBe(true);
    expect(isPreferenceKey('defaultTenantId')).toBe(false);
    expect(isPreferenceValue('density', 'compact')).toBe(true);
    expect(isPreferenceValue('theme', 'system')).toBe(true);
    expect(isPreferenceValue('theme', 'neon')).toBe(false);
    expect(isPreferenceValue('theme', 1)).toBe(false);
    expect(isPreferenceValue('toString', 'x')).toBe(false);
  });
});
