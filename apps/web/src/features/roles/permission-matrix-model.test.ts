import { PERMISSIONS } from '@contrataflow/types';
import { ADMIN_ORGAO_SEEDED_PERMISSIONS } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { actorReach, groupByModule, matrixDiff, switchState } from './permission-matrix-model';

const ADMIN = actorReach([...ADMIN_ORGAO_SEEDED_PERMISSIONS]);
const CARLOS = actorReach(['ROLE_MANAGE', 'PROCESS_VIEW']);

describe('Matriz de permissões — regras de exibição (US-095)', () => {
  it('actorReach: isento de POL-13 só com todas as permissões semeadas do ADMIN_ORGAO', () => {
    expect(ADMIN.exempt).toBe(true);
    expect(CARLOS.exempt).toBe(false);
    expect(actorReach([]).exempt).toBe(false);
  });

  it.each([
    // [code, perfil protegido, concedidas, pode gerenciar, ator, estado]
    ['USER_MANAGE', true, ['USER_MANAGE'], true, ADMIN, 'protected'],
    ['SUPPLIER_VIEW', true, ['USER_MANAGE'], true, ADMIN, 'enabled'],
    ['USER_MANAGE', false, ['USER_MANAGE'], true, ADMIN, 'enabled'],
    ['SETTINGS_MANAGE', false, [], true, CARLOS, 'out-of-reach'],
    ['SETTINGS_MANAGE', false, ['SETTINGS_MANAGE'], true, CARLOS, 'enabled'],
    ['PROCESS_VIEW', false, [], true, CARLOS, 'enabled'],
    ['PROCESS_VIEW', false, [], false, ADMIN, 'readonly'],
    ['SETTINGS_MANAGE', false, [], true, ADMIN, 'enabled'],
  ] as const)(
    '%s (protegido=%s, concedidas=%j, gerencia=%s) → %s',
    (code, isProtectedRole, granted, canManage, actor, expected) => {
      expect(
        switchState({ code, isProtectedRole, granted: new Set(granted), canManage, actor }),
      ).toBe(expected);
    },
  );

  it('matrixDiff e groupByModule', () => {
    expect(matrixDiff(new Set(['A', 'B']), new Set(['B', 'C']))).toEqual({
      added: ['C'],
      removed: ['A'],
    });
    const groups = groupByModule(PERMISSIONS.map((permission) => ({ ...permission })));
    expect(groups[0]?.module).toBe(PERMISSIONS[0].module);
    expect(groups.reduce((sum, group) => sum + group.items.length, 0)).toBe(PERMISSIONS.length);
  });
});
