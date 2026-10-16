import { describe, expect, it } from 'vitest';

import { buildVisibilityPredicate } from './process-visibility.js';

/*
 * US-097 — predicado SQL de visibilidade (DEC-024 · permissions.md §5 · RN-IAM-103): forma e
 * parâmetros. A semântica sobre o PostgreSQL real está em `test/access/authorization.spec.ts`.
 */

const SCOPE = {
  userId: '0192a000-0000-7000-8000-0000000000a1',
  tenantWide: false,
  organizationIds: ['0192a000-0000-7000-8000-0000000000f1'],
  departmentIds: ['0192a000-0000-7000-8000-0000000000d1'],
};

describe('buildVisibilityPredicate (DEC-024)', () => {
  it('compõe o predicado de referência com todos os valores parametrizados', () => {
    const predicate = buildVisibilityPredicate(SCOPE);
    const sql = predicate.sql.replace(/\s+/g, ' ');
    expect(sql).toContain("p.tenant_id = current_setting('app.tenant_id')::uuid");
    expect(sql).toContain('p.deleted_at IS NULL');
    expect(sql).toContain('p.organization_id = ANY(');
    expect(sql).toContain("pa.principal_type = 'DEPARTMENT'");
    expect(sql).toContain("pa.principal_type = 'USER'");
    expect(sql).not.toContain(SCOPE.userId);
    expect(predicate.values).toEqual([
      false,
      SCOPE.organizationIds,
      SCOPE.departmentIds,
      ['REQUESTING', 'CURRENT', 'HISTORICAL'],
      SCOPE.userId,
    ]);
  });

  it('alias da tabela e unidades históricas configuráveis', () => {
    const predicate = buildVisibilityPredicate(SCOPE, {
      processAlias: 'proc',
      historicalDepartmentsCanView: false,
    });
    expect(predicate.sql).toContain('proc.tenant_id');
    expect(predicate.sql).not.toContain(' p.');
    expect(predicate.values).toContainEqual(['REQUESTING', 'CURRENT']);
  });

  it('alias que não é identificador SQL é recusado (nunca interpolado)', () => {
    expect(() => buildVisibilityPredicate(SCOPE, { processAlias: 'p; DROP TABLE x' })).toThrow(
      /Alias SQL inválido/,
    );
  });
});
