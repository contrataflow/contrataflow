import { describe, expect, it } from 'vitest';

import {
  isPermissionCode,
  PERMISSION_CODES,
  PERMISSION_MODULES,
  PERMISSION_RISK_LEVELS,
  PERMISSIONS,
} from './permissions.js';

/** Catálogo do MVP 1 (permissions.md §2 · RN-IAM-73). */
describe('catálogo de permissões', () => {
  it('tem as 68 permissões de permissions.md §2, sem códigos repetidos', () => {
    expect(PERMISSIONS).toHaveLength(68);
    expect(new Set(PERMISSION_CODES).size).toBe(PERMISSIONS.length);
  });

  it('toda entrada tem módulo, nome, descrição, risco, escopo, descontinuação e versão', () => {
    for (const permission of PERMISSIONS) {
      expect(permission.module).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
      expect(permission.name.trim()).not.toBe('');
      expect(permission.name.length).toBeLessThanOrEqual(120);
      expect(permission.description.trim()).not.toBe('');
      expect(PERMISSION_RISK_LEVELS).toContain(permission.riskLevel);
      expect(typeof permission.scopable).toBe('boolean');
      expect(permission.isDeprecated).toBe(false);
      expect(permission.introducedIn).toBe('MVP1');
    }
  });

  it('agrupa por módulo na ordem do documento', () => {
    expect(PERMISSION_MODULES[0]).toBe('process');
    expect(PERMISSION_MODULES).toContain('access');
    expect(PERMISSIONS.find((p) => p.code === 'ROLE_VIEW')).toMatchObject({
      module: 'access',
      riskLevel: 'LOW',
      scopable: false,
    });
  });

  it('isPermissionCode reconhece só códigos do catálogo', () => {
    expect(isPermissionCode('ROLE_VIEW')).toBe(true);
    expect(isPermissionCode('ROLE_DESTROY')).toBe(false);
  });
});
