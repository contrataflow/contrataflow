import { PERMISSION_CODES } from '@contrataflow/types';
import { describe, expect, it } from 'vitest';

import { PERMISSION_RISKS, ROLE_GRANTS, rolesGrant } from './permission-grants.js';

describe('concessões padrão por perfil (permissions.md §3.2)', () => {
  it('toda permissão do catálogo tem risco e ao menos um perfil padrão que a concede', () => {
    for (const code of PERMISSION_CODES) {
      expect(['LOW', 'MEDIUM', 'HIGH']).toContain(PERMISSION_RISKS[code]);
      expect(ROLE_GRANTS[code].length).toBeGreaterThan(0);
    }
  });

  it('DOCUMENT_TYPE_MANAGE é só do ADMIN_ORGAO', () => {
    expect(ROLE_GRANTS.DOCUMENT_TYPE_MANAGE).toEqual(['ADMIN_ORGAO']);
    expect(rolesGrant(['ADMIN_ORGAO'], 'DOCUMENT_TYPE_MANAGE')).toBe(true);
    expect(rolesGrant(['GESTOR_CONTRATACOES', 'JURIDICO'], 'DOCUMENT_TYPE_MANAGE')).toBe(false);
    expect(rolesGrant([], 'DOCUMENT_TYPE_MANAGE')).toBe(false);
  });

  it('APPROVAL_DECIDE não é do ADMIN_ORGAO nem do fiscal; o gestor decide', () => {
    expect(rolesGrant(['GESTOR_CONTRATACOES'], 'APPROVAL_DECIDE')).toBe(true);
    expect(rolesGrant(['ADMIN_ORGAO'], 'APPROVAL_DECIDE')).toBe(false);
    expect(rolesGrant(['FISCAL_CONTRATO'], 'APPROVAL_DECIDE')).toBe(false);
  });

  it('ROLE_VIEW é do ADMIN_ORGAO e do AUDITOR (ROL-01)', () => {
    expect(ROLE_GRANTS.ROLE_VIEW).toEqual(['ADMIN_ORGAO', 'AUDITOR']);
    expect(rolesGrant(['SOMENTE_LEITURA'], 'ROLE_VIEW')).toBe(false);
  });
});
