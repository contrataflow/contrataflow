import { describe, expect, it } from 'vitest';

import { isUsable } from './tenant-membership.js';
import type { TenantMembership } from './tenant-membership.js';
import {
  bindExternalSubject,
  canSignIn,
  defaultTenantOf,
  displayName,
  InvalidPreferenceValueError,
  interfacePreferences,
  maskEmail,
  maskPhone,
  SubjectAlreadyBoundError,
  UnknownPreferenceKeysError,
  updateProfile,
} from './user.js';

describe('User (entities.md §4.2)', () => {
  it('bindExternalSubject: vincula o sub vazio, é idempotente e nunca troca de sub (RN-IAM-06)', () => {
    expect(bindExternalSubject({ externalSubject: null }, 'sub-1')).toBe(true);
    expect(bindExternalSubject({ externalSubject: 'sub-1' }, 'sub-1')).toBe(false);
    expect(() => bindExternalSubject({ externalSubject: 'sub-1' }, 'sub-2')).toThrow(
      SubjectAlreadyBoundError,
    );
  });

  it('displayName: nome social quando houver (Decreto 8.727/2016)', () => {
    expect(displayName({ name: 'Rafael Nogueira', socialName: null })).toBe('Rafael Nogueira');
    expect(displayName({ name: 'Fábio Nunes', socialName: '  Fabi Nunes ' })).toBe('Fabi Nunes');
    expect(displayName({ name: 'Ana', socialName: '   ' })).toBe('Ana');
  });

  it('canSignIn: só ACTIVE (RN-IAM-07)', () => {
    expect(canSignIn({ status: 'ACTIVE' })).toBe(true);
    expect(canSignIn({ status: 'BLOCKED' })).toBe(false);
    expect(canSignIn({ status: 'DEACTIVATED' })).toBe(false);
  });

  it('interfacePreferences: padrões do registro quando ausentes ou inválidas', () => {
    expect(interfacePreferences({ preferences: {} })).toEqual({
      density: 'comfortable',
      theme: 'system',
    });
    expect(interfacePreferences({ preferences: { density: 'compact', theme: 1 } })).toEqual({
      density: 'compact',
      theme: 'system',
    });
  });

  it('defaultTenantOf: instituição padrão só quando é um UUID (FA-04 da US-093)', () => {
    const tenant = '0192A000-0000-7000-8000-00000000000B';
    expect(defaultTenantOf({ preferences: { defaultTenantId: tenant } })).toBe(
      tenant.toLowerCase(),
    );
    expect(defaultTenantOf({ preferences: {} })).toBeNull();
    expect(defaultTenantOf({ preferences: { defaultTenantId: 'prefeitura-b' } })).toBeNull();
    expect(defaultTenantOf({ preferences: { defaultTenantId: 42 } })).toBeNull();
  });

  it('maskEmail: mantém só a inicial e o domínio (DEC-138)', () => {
    expect(maskEmail('claudia@saojose.sp.gov.br')).toBe('c***@saojose.sp.gov.br');
    expect(maskEmail('sem-arroba')).toBe('***');
  });
});

describe('TenantMembership.isUsable', () => {
  const membership: TenantMembership = {
    id: '0192a000-0000-7000-8000-0000000001a1',
    tenant: {
      id: '0192a000-0000-7000-8000-00000000000a',
      name: 'Prefeitura A',
      status: 'OFFBOARDING',
      timezone: 'America/Sao_Paulo',
    },
    type: 'INTERNAL',
    status: 'ACTIVE',
    expiresAt: null,
    roleKeys: ['AUDITOR'],
  };

  it('aplica a política do vínculo com o status e os perfis do próprio vínculo', () => {
    const now = new Date('2026-10-14T12:00:00Z');
    expect(isUsable(membership, now)).toEqual({ usable: true, readOnly: true });
    expect(isUsable({ ...membership, roleKeys: [] }, now)).toEqual({
      usable: false,
      reason: 'TENANT_SUSPENDED',
    });
  });
});

describe('User.updateProfile (US-098 · RN-IAM-109..113)', () => {
  const user = {
    name: 'Ana Souza',
    socialName: null,
    phone: null,
    preferences: { defaultTenantId: '0192a000-0000-7000-8000-0000000000b1' },
  };

  it('aplica os campos enviados e lista só o que mudou, com o telefone mascarado', () => {
    const update = updateProfile(user, {
      name: 'Ana Maria Souza',
      socialName: 'Aninha',
      phone: '(11) 91234-5678',
      preferences: { theme: 'dark' },
    });
    expect(update).toMatchObject({
      name: 'Ana Maria Souza',
      socialName: 'Aninha',
      phone: '(11) 91234-5678',
    });
    expect(update.changes).toEqual([
      { path: 'name', old: 'Ana Souza', new: 'Ana Maria Souza' },
      { path: 'socialName', old: null, new: 'Aninha' },
      { path: 'phone', old: null, new: '***5678' },
      { path: 'preferences.theme', old: 'system', new: 'dark' },
    ]);
  });

  it('preserva as chaves de preferência não enviadas (inclusive defaultTenantId da US-093)', () => {
    const update = updateProfile(user, { preferences: { density: 'compact' } });
    expect(update.preferences).toEqual({
      defaultTenantId: '0192a000-0000-7000-8000-0000000000b1',
      density: 'compact',
    });
  });

  it('campos ausentes ficam como estão; null/vazio limpa o nome social e o telefone (FA-01)', () => {
    const social = { ...user, socialName: 'Aninha', phone: '11912345678' };
    expect(updateProfile(social, {}).changes).toEqual([]);
    const cleared = updateProfile(social, { socialName: null, phone: null });
    expect(cleared).toMatchObject({ name: 'Ana Souza', socialName: null, phone: null });
    expect(cleared.changes).toEqual([
      { path: 'socialName', old: 'Aninha', new: null },
      { path: 'phone', old: '***5678', new: null },
    ]);
  });

  it('valores iguais aos atuais (inclusive padrão de preferência) não geram mudança', () => {
    expect(
      updateProfile(user, { name: 'Ana Souza', preferences: { theme: 'system' } }).changes,
    ).toEqual([]);
  });

  it('RN-IAM-111: chave fora do registro é recusada por inteiro; valor fora do registro também', () => {
    expect(() => updateProfile(user, { name: 'Outra', preferences: { fontSize: 'xl' } })).toThrow(
      UnknownPreferenceKeysError,
    );
    expect(() => updateProfile(user, { preferences: { defaultTenantId: 'x' } })).toThrow(
      UnknownPreferenceKeysError,
    );
    expect(() => updateProfile(user, { preferences: { theme: 'neon' } })).toThrow(
      InvalidPreferenceValueError,
    );
    expect(() => updateProfile(user, { preferences: { density: 3 } })).toThrow(
      InvalidPreferenceValueError,
    );
  });

  it('maskPhone mostra só os 4 últimos dígitos', () => {
    expect(maskPhone('(11) 91234-5678')).toBe('***5678');
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone('12')).toBe('***');
  });
});
