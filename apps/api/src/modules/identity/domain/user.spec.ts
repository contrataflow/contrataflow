import { describe, expect, it } from 'vitest';

import { isUsable } from './tenant-membership.js';
import type { TenantMembership } from './tenant-membership.js';
import {
  bindExternalSubject,
  canSignIn,
  displayName,
  interfacePreferences,
  maskEmail,
  SubjectAlreadyBoundError,
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
