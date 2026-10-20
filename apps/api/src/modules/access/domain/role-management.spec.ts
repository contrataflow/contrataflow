import type { PermissionCode } from '@contrataflow/types';
import { ADMIN_ORGAO_SEEDED_PERMISSIONS } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { DEFAULT_ROLE_GRANTS } from './default-roles.js';
import { PERMISSION_RISKS } from './permission-grants.js';
import {
  assertNoPrivilegeEscalation,
  assertProtectedPermissionsKept,
  createRole,
  DeactivationNotConfirmedError,
  deactivateRole,
  diffPermissions,
  duplicateRoleName,
  externalAssignmentNeedsMfa,
  generateRoleKey,
  isProtectedPermission,
  LastAdminRequiredError,
  PrivilegeEscalationError,
  ProtectedPermissionRemovalError,
  RoleKeyUnderivableError,
  sameRoleName,
  updateRoleDetails,
} from './role-management.js';
import type { Role } from './role.js';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const LATER = new Date('2026-10-15T13:00:00.000Z');
const DATA = { id: 'r1', tenantId: 't1', now: NOW, userId: 'u1' };

const role = (overrides: Partial<Role> = {}): Role => ({
  ...createRole({ name: 'Fiscal de Obras' }, DATA),
  ...overrides,
});

const riskOf = (code: PermissionCode) => PERMISSION_RISKS[code];

describe('Role (US-095 · RN-IAM-80..87)', () => {
  describe('generateRoleKey (RN-IAM-80)', () => {
    it.each([
      ['Fiscal de Obras', 'FISCAL_DE_OBRAS'],
      ['  Gestão — Licitações / Compras ', 'GESTAO_LICITACOES_COMPRAS'],
      ['Área técnica (cópia 2)', 'AREA_TECNICA_COPIA_2'],
      ['123 Secretaria', 'PERFIL_123_SECRETARIA'],
      ['Ação', 'ACAO'],
    ])('"%s" → %s', (name, key) => {
      expect(generateRoleKey(name)).toBe(key);
    });

    it('limita a 60 caracteres sem terminar em "_" e respeita o check do banco', () => {
      const key = generateRoleKey(`${'a'.repeat(59)} b`) ?? '';
      expect(key).toBe('A'.repeat(59));
      expect(generateRoleKey('x'.repeat(120))).toHaveLength(60);
      for (const name of ['Fiscal de Obras', '9 vidas', 'É ótimo!']) {
        expect(generateRoleKey(name)).toMatch(/^[A-Z][A-Z0-9_]{1,59}$/);
      }
    });

    it('nome sem letras nem dígitos não gera chave', () => {
      expect(generateRoleKey('!!! ---')).toBeNull();
      expect(() => createRole({ name: '***' }, DATA)).toThrow(RoleKeyUnderivableError);
    });
  });

  it('createRole: personalizado, ativo, versão 1, sem descrição vazia, atribuição externa opcional', () => {
    expect(role()).toEqual({
      id: 'r1',
      tenantId: 't1',
      key: 'FISCAL_DE_OBRAS',
      name: 'Fiscal de Obras',
      description: null,
      isSystem: false,
      isProtected: false,
      allowExternalAssignment: false,
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
      createdById: 'u1',
      updatedById: 'u1',
      version: 1,
    });
    expect(
      createRole({ name: 'X Y Z', description: 'd', allowExternalAssignment: true }, DATA),
    ).toMatchObject({ description: 'd', allowExternalAssignment: true });
    expect(createRole({ name: 'X Y Z', description: '' }, DATA).description).toBeNull();
  });

  it('sameRoleName compara sem distinção de maiúsculas', () => {
    expect(sameRoleName('Fiscal de Obras', 'FISCAL DE OBRAS')).toBe(true);
    expect(sameRoleName('Fiscal', 'Fiscais')).toBe(false);
  });

  describe('updateRoleDetails (ROL-05)', () => {
    it('só os campos alterados, com valores anterior e novo', () => {
      const result = updateRoleDetails(
        role({ description: 'antiga' }),
        { name: 'Fiscal de Obras', description: null, allowExternalAssignment: true },
        { now: LATER, userId: 'u2' },
      );
      expect(result.changes).toEqual([
        { path: 'description', old: 'antiga', new: null },
        { path: 'allowExternalAssignment', old: false, new: true },
      ]);
      expect(result.next).toMatchObject({
        name: 'Fiscal de Obras',
        description: null,
        allowExternalAssignment: true,
        updatedAt: LATER,
        updatedById: 'u2',
        key: 'FISCAL_DE_OBRAS',
      });
    });

    it('nada mudou → mesmo perfil, sem mudanças', () => {
      const current = role();
      const result = updateRoleDetails(
        current,
        { name: 'Fiscal de Obras', description: '' },
        {
          now: LATER,
          userId: 'u2',
        },
      );
      expect(result).toEqual({ next: current, changes: [] });
    });

    it('renomear não altera a chave', () => {
      const { next, changes } = updateRoleDetails(
        role(),
        { name: 'Fiscal Geral' },
        {
          now: LATER,
          userId: null,
        },
      );
      expect(next).toMatchObject({ name: 'Fiscal Geral', key: 'FISCAL_DE_OBRAS' });
      expect(changes).toEqual([{ path: 'name', old: 'Fiscal de Obras', new: 'Fiscal Geral' }]);
    });
  });

  describe('externalAssignmentNeedsMfa (RN-IAM-83)', () => {
    it.each([
      [false, true, ['PROCESS_CANCEL'], true],
      [false, true, ['PROCESS_VIEW'], false],
      [true, true, ['PROCESS_CANCEL'], false],
      [false, false, ['PROCESS_CANCEL'], false],
      [false, true, [], false],
    ] as const)('de %s para %s com %j → %s', (wasAllowed, willAllow, permissions, expected) => {
      expect(externalAssignmentNeedsMfa({ wasAllowed, willAllow, permissions, riskOf })).toBe(
        expected,
      );
    });
  });

  it('diffPermissions separa adicionadas e removidas', () => {
    expect(
      diffPermissions(['PROCESS_VIEW', 'SUPPLIER_VIEW'], ['SUPPLIER_VIEW', 'AUDIT_VIEW']),
    ).toEqual({ added: ['AUDIT_VIEW'], removed: ['PROCESS_VIEW'] });
    expect(diffPermissions(['PROCESS_VIEW'], ['PROCESS_VIEW'])).toEqual({
      added: [],
      removed: [],
    });
  });

  describe('POL-13 — assertNoPrivilegeEscalation (RN-IAM-81)', () => {
    const actor = { permissions: new Set<PermissionCode>(['PROCESS_VIEW', 'ROLE_MANAGE']) };

    it('concede só o que o ator possui', () => {
      expect(() => {
        assertNoPrivilegeEscalation(['PROCESS_VIEW'], { ...actor, isTenantAdmin: false });
      }).not.toThrow();
      expect(() => {
        assertNoPrivilegeEscalation([], { ...actor, isTenantAdmin: false });
      }).not.toThrow();
    });

    it('permissão que o ator não tem → erro com a lista das que faltam', () => {
      try {
        assertNoPrivilegeEscalation(['PROCESS_VIEW', 'SETTINGS_MANAGE', 'AUDIT_VIEW'], {
          ...actor,
          isTenantAdmin: false,
        });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(PrivilegeEscalationError);
        expect((error as PrivilegeEscalationError).permissions).toEqual([
          'SETTINGS_MANAGE',
          'AUDIT_VIEW',
        ]);
      }
    });

    it('ADMIN_ORGAO é isento', () => {
      expect(() => {
        assertNoPrivilegeEscalation(['SETTINGS_MANAGE'], {
          permissions: new Set(),
          isTenantAdmin: true,
        });
      }).not.toThrow();
    });
  });

  describe('RN-IAM-82 — permissões protegidas do ADMIN_ORGAO (DEC-035)', () => {
    it('a lista protegida é exatamente a coluna ADMIN_ORGAO da matriz padrão', () => {
      expect([...ADMIN_ORGAO_SEEDED_PERMISSIONS].sort()).toEqual(
        [...DEFAULT_ROLE_GRANTS.ADMIN_ORGAO].sort(),
      );
    });

    it('perfil protegido não perde permissão semeada; acrescentar ou remover as novas é livre', () => {
      const admin = role({ key: 'ADMIN_ORGAO', isSystem: true, isProtected: true });
      expect(() => {
        assertProtectedPermissionsKept(admin, ['SUPPLIER_VIEW']);
      }).not.toThrow();
      expect(() => {
        assertProtectedPermissionsKept(admin, []);
      }).not.toThrow();
      try {
        assertProtectedPermissionsKept(admin, ['SUPPLIER_VIEW', 'USER_MANAGE', 'ROLE_MANAGE']);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ProtectedPermissionRemovalError);
        expect((error as ProtectedPermissionRemovalError).permissions).toEqual([
          'USER_MANAGE',
          'ROLE_MANAGE',
        ]);
      }
      expect(isProtectedPermission(admin, 'USER_MANAGE')).toBe(true);
      expect(isProtectedPermission(admin, 'SUPPLIER_VIEW')).toBe(false);
    });

    it('perfil não protegido pode perder qualquer permissão', () => {
      expect(() => {
        assertProtectedPermissionsKept(role(), ['USER_MANAGE']);
      }).not.toThrow();
      expect(isProtectedPermission(role(), 'USER_MANAGE')).toBe(false);
    });
  });

  describe('deactivateRole (RN-IAM-84 · POL-12 · FA-04)', () => {
    const data = { now: LATER, userId: 'u2' };

    it('desativa preservando o resto', () => {
      expect(
        deactivateRole(role(), { activeAssignments: 0, confirmed: false }, data),
      ).toMatchObject({ isActive: false, updatedAt: LATER, updatedById: 'u2', version: 1 });
    });

    it('ADMIN_ORGAO nunca (protegido ou pela chave)', () => {
      const confirmed = { activeAssignments: 0, confirmed: true };
      expect(() => deactivateRole(role({ isProtected: true }), confirmed, data)).toThrow(
        LastAdminRequiredError,
      );
      expect(() => deactivateRole(role({ key: 'ADMIN_ORGAO' }), confirmed, data)).toThrow(
        LastAdminRequiredError,
      );
    });

    it('com vínculos ativos exige confirmação explícita', () => {
      expect(() =>
        deactivateRole(role(), { activeAssignments: 2, confirmed: false }, data),
      ).toThrow(DeactivationNotConfirmedError);
      expect(
        deactivateRole(role(), { activeAssignments: 2, confirmed: true }, data)?.isActive,
      ).toBe(false);
    });

    it('já inativo → nada a fazer', () => {
      expect(
        deactivateRole(role({ isActive: false }), { activeAssignments: 0, confirmed: false }, data),
      ).toBeNull();
    });
  });

  describe('duplicateRoleName (RN-IAM-86)', () => {
    it('"(cópia)" e, se já existir (nome ou chave), "(cópia N)"', () => {
      expect(duplicateRoleName('Fiscal', { names: ['Fiscal'], keys: ['FISCAL'] })).toBe(
        'Fiscal (cópia)',
      );
      expect(
        duplicateRoleName('Fiscal', { names: ['fiscal (CÓPIA)'], keys: ['FISCAL_COPIA'] }),
      ).toBe('Fiscal (cópia 2)');
      expect(duplicateRoleName('Fiscal', { names: [], keys: ['FISCAL_COPIA'] })).toBe(
        'Fiscal (cópia 2)',
      );
    });

    it('encurta o nome de origem para caber em 120 caracteres', () => {
      const name = duplicateRoleName('n'.repeat(120), { names: [], keys: [] });
      expect(name).toHaveLength(120);
      expect(name.endsWith(' (cópia)')).toBe(true);
    });
  });
});
