import { describe, expect, it } from 'vitest';

import {
  allowedMembershipActions,
  canTransition,
  departmentReferenceErrors,
  membershipValidityError,
  primaryFirst,
  profileChanges,
  removesAccess,
  sameDepartments,
  transitionSources,
  transitionTarget,
  validityNotAllowedError,
  violatesLastAdmin,
  violatesSelfProtection,
} from './membership-lifecycle.js';

const now = new Date('2026-10-15T12:00:00.000Z');
const DAY = 24 * 3_600_000;

describe('Ciclo de vida do vínculo (US-092)', () => {
  describe('transições (RN-IAM-57..59)', () => {
    it('suspender só ACTIVE; reativar só SUSPENDED; revogar qualquer um menos REVOKED', () => {
      expect(canTransition('SUSPEND', 'ACTIVE')).toBe(true);
      expect(canTransition('SUSPEND', 'SUSPENDED')).toBe(false);
      expect(canTransition('SUSPEND', 'INVITED')).toBe(false);
      expect(canTransition('REACTIVATE', 'SUSPENDED')).toBe(true);
      expect(canTransition('REACTIVATE', 'ACTIVE')).toBe(false);
      expect(canTransition('REACTIVATE', 'REVOKED')).toBe(false);
      for (const status of ['INVITED', 'ACTIVE', 'SUSPENDED', 'EXPIRED'] as const) {
        expect(canTransition('REVOKE', status)).toBe(true);
      }
      expect(canTransition('REVOKE', 'REVOKED')).toBe(false);
    });

    it('destino e origens de cada transição', () => {
      expect(transitionTarget('SUSPEND')).toBe('SUSPENDED');
      expect(transitionTarget('REACTIVATE')).toBe('ACTIVE');
      expect(transitionTarget('REVOKE')).toBe('REVOKED');
      expect(transitionSources('SUSPEND')).toEqual(['ACTIVE']);
      expect(transitionSources('REACTIVATE')).toEqual(['SUSPENDED']);
      expect(transitionSources('REVOKE')).not.toContain('REVOKED');
    });

    it('suspender e revogar tiram o acesso; reativar não', () => {
      expect(removesAccess('SUSPEND')).toBe(true);
      expect(removesAccess('REVOKE')).toBe(true);
      expect(removesAccess('REACTIVATE')).toBe(false);
    });
  });

  describe('POL-16 — autoproteção', () => {
    it('viola ao suspender/revogar o próprio vínculo', () => {
      expect(violatesSelfProtection('SUSPEND', 'm1', 'm1')).toBe(true);
      expect(violatesSelfProtection('REVOKE', 'm1', 'm1')).toBe(true);
    });

    it('não viola sobre outro vínculo, na reativação ou sem vínculo do ator', () => {
      expect(violatesSelfProtection('SUSPEND', 'm1', 'm2')).toBe(false);
      expect(violatesSelfProtection('REACTIVATE', 'm1', 'm1')).toBe(false);
      expect(violatesSelfProtection('REVOKE', 'm1', null)).toBe(false);
    });
  });

  describe('POL-12 — anti-bloqueio', () => {
    it('viola quando o alvo é o único administrador ativo', () => {
      expect(violatesLastAdmin('m1', ['m1'])).toBe(true);
    });

    it('não viola com outro administrador ativo ou alvo que não é administrador ativo', () => {
      expect(violatesLastAdmin('m1', ['m1', 'm2'])).toBe(false);
      expect(violatesLastAdmin('m3', ['m1'])).toBe(false);
      expect(violatesLastAdmin('m1', [])).toBe(false);
    });
  });

  describe('ações do detalhe (meta.allowedActions)', () => {
    it('sem USER_MANAGE nenhuma ação', () => {
      expect(
        allowedMembershipActions({ status: 'ACTIVE', canManage: false, isSelf: false }),
      ).toEqual([]);
    });

    it('por status, e sem suspender/revogar o próprio vínculo', () => {
      expect(
        allowedMembershipActions({ status: 'ACTIVE', canManage: true, isSelf: false }),
      ).toEqual(['UPDATE', 'UPDATE_DEPARTMENTS', 'SUSPEND', 'REVOKE']);
      expect(allowedMembershipActions({ status: 'ACTIVE', canManage: true, isSelf: true })).toEqual(
        ['UPDATE', 'UPDATE_DEPARTMENTS'],
      );
      expect(
        allowedMembershipActions({ status: 'SUSPENDED', canManage: true, isSelf: false }),
      ).toEqual(['UPDATE', 'UPDATE_DEPARTMENTS', 'REACTIVATE', 'REVOKE']);
      expect(
        allowedMembershipActions({ status: 'REVOKED', canManage: true, isSelf: false }),
      ).toEqual([]);
    });
  });

  describe('validade do EXTERNAL (V-02 · RN-IAM-55)', () => {
    it('aceita entre hoje (exclusive) e hoje + máximo (inclusive)', () => {
      expect(membershipValidityError(new Date(now.getTime() + DAY), now, 180)).toBeNull();
      expect(membershipValidityError(new Date(now.getTime() + 180 * DAY), now, 180)).toBeNull();
    });

    it('recusa hoje, passado ou além do máximo com OUT_OF_RANGE', () => {
      for (const date of [
        now,
        new Date(now.getTime() - DAY),
        new Date(now.getTime() + 181 * DAY),
      ]) {
        expect(membershipValidityError(date, now, 180)).toEqual({
          field: 'expiresAt',
          code: 'OUT_OF_RANGE',
          message: 'Informe uma validade entre hoje e 180 dias.',
        });
      }
    });

    it('só EXTERNAL tem validade', () => {
      expect(validityNotAllowedError('EXTERNAL')).toBeNull();
      expect(validityNotAllowedError('INTERNAL')).toMatchObject({
        field: 'expiresAt',
        code: 'NOT_ALLOWED',
      });
    });
  });

  describe('lotação (V-03 · RN-IAM-56)', () => {
    const departments = new Map([
      ['d1', { isActive: true }],
      ['d2', { isActive: false }],
    ]);

    it('aceita unidades ativas do tenant', () => {
      expect(departmentReferenceErrors(['d1'], departments)).toEqual([]);
    });

    it('recusa unidade inativa ou inexistente (outro tenant)', () => {
      expect(departmentReferenceErrors(['d1', 'd2'], departments)).toEqual([
        expect.objectContaining({ field: 'departmentIds', code: 'REFERENCE_INACTIVE' }),
      ]);
      expect(departmentReferenceErrors(['d9'], departments)).toEqual([
        expect.objectContaining({ field: 'departmentIds', code: 'REFERENCE_NOT_FOUND' }),
      ]);
    });

    it('a principal vai para a primeira posição; mesmo conjunto e principal não mudam nada', () => {
      expect(primaryFirst(['d1', 'd2', 'd3'], 'd2')).toEqual(['d2', 'd1', 'd3']);
      expect(sameDepartments(['d2', 'd1'], ['d2', 'd1'])).toBe(true);
      expect(sameDepartments(['d2', 'd1'], ['d1', 'd2'])).toBe(false);
      expect(sameDepartments(['d2'], ['d2', 'd1'])).toBe(false);
      expect(sameDepartments(['d2', 'd1'], ['d2', 'd3'])).toBe(false);
    });
  });

  describe('diff do USR-08', () => {
    const current = { jobTitle: 'Analista', registrationNumber: null, expiresAt: null };

    it('só os campos informados que mudaram; texto vazio limpa', () => {
      expect(
        profileChanges(current, {
          jobTitle: '',
          registrationNumber: 'M-1',
          expiresAt: new Date('2026-12-01T00:00:00.000Z'),
        }),
      ).toEqual([
        { path: 'jobTitle', old: 'Analista', new: null },
        { path: 'registrationNumber', old: null, new: 'M-1' },
        { path: 'expiresAt', old: null, new: '2026-12-01T00:00:00.000Z' },
      ]);
    });

    it('nada informado ou mesmos valores → sem mudança', () => {
      expect(profileChanges(current, {})).toEqual([]);
      expect(profileChanges(current, { jobTitle: 'Analista', registrationNumber: null })).toEqual(
        [],
      );
      const expiring = { ...current, expiresAt: new Date('2026-12-01T00:00:00.000Z') };
      expect(profileChanges(expiring, { expiresAt: new Date('2026-12-01T00:00:00.000Z') })).toEqual(
        [],
      );
    });
  });
});
