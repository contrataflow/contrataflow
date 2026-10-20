import { describe, expect, it } from 'vitest';

import { competenceSubtreeRoots, scopeCoversRequestingUnits } from './approval-competence.js';
import type { AssignmentScope } from './role-assignment.js';

/*
 * US-051 · RN-TRAM-47 · DEC-022 — competência de aprovar por perfil: só o ESCOPO da atribuição
 * cobrindo a unidade solicitante conta; ter tramitado o processo (`CURRENT`/`HISTORICAL`) não.
 */

const ORG = '0192f051-0000-7000-8000-0000000000b0';
const OTHER_ORG = '0192f051-0000-7000-8000-0000000000b9';
const SECRETARIAT = '0192f051-0000-7000-8000-0000000000b1';
const SECTOR = '0192f051-0000-7000-8000-0000000000b2';
const PARENT = '0192f051-0000-7000-8000-0000000000b3';
/** Unidade pela qual o processo apenas tramitou (concessão `HISTORICAL`). */
const VISITED = '0192f051-0000-7000-8000-0000000000b4';

const target = { organizationId: ORG, departmentIds: [SECRETARIAT, SECTOR] };
const scope = (overrides: Partial<AssignmentScope>): AssignmentScope => ({
  scopeType: 'TENANT',
  scopeOrganizationId: null,
  scopeDepartmentId: null,
  includeSubtree: false,
  ...overrides,
});
const holder = (
  ownDepartmentIds: readonly string[] = [],
  subtrees: ReadonlyMap<string, readonly string[]> = new Map(),
) => ({ ownDepartmentIds, subtrees });

describe('scopeCoversRequestingUnits', () => {
  it('TENANT cobre qualquer processo do tenant', () => {
    expect(scopeCoversRequestingUnits(scope({}), target, holder())).toBe(true);
  });

  it('ORGANIZATION só o órgão do processo', () => {
    expect(
      scopeCoversRequestingUnits(
        scope({ scopeType: 'ORGANIZATION', scopeOrganizationId: ORG }),
        target,
        holder(),
      ),
    ).toBe(true);
    expect(
      scopeCoversRequestingUnits(
        scope({ scopeType: 'ORGANIZATION', scopeOrganizationId: OTHER_ORG }),
        target,
        holder(),
      ),
    ).toBe(false);
  });

  it('DEPARTMENT: a secretaria ou o setor solicitante; a unidade-mãe só com subárvore', () => {
    expect(
      scopeCoversRequestingUnits(
        scope({ scopeType: 'DEPARTMENT', scopeDepartmentId: SECTOR }),
        target,
        holder(),
      ),
    ).toBe(true);
    const parent = scope({ scopeType: 'DEPARTMENT', scopeDepartmentId: PARENT });
    expect(scopeCoversRequestingUnits(parent, target, holder())).toBe(false);
    const withSubtree = { ...parent, includeSubtree: true };
    expect(competenceSubtreeRoots(withSubtree, [])).toEqual([PARENT]);
    expect(
      scopeCoversRequestingUnits(
        withSubtree,
        target,
        holder([], new Map([[PARENT, [PARENT, SECRETARIAT]]])),
      ),
    ).toBe(true);
  });

  it('DEPARTMENT de unidade pela qual o processo só tramitou não dá competência', () => {
    expect(
      scopeCoversRequestingUnits(
        scope({ scopeType: 'DEPARTMENT', scopeDepartmentId: VISITED }),
        target,
        holder([VISITED]),
      ),
    ).toBe(false);
  });

  it('OWN_DEPARTMENTS: lotação na unidade solicitante (ou acima, com subárvore)', () => {
    const own = scope({ scopeType: 'OWN_DEPARTMENTS' });
    expect(scopeCoversRequestingUnits(own, target, holder([SECRETARIAT]))).toBe(true);
    expect(scopeCoversRequestingUnits(own, target, holder([VISITED]))).toBe(false);
    expect(competenceSubtreeRoots(own, [PARENT])).toEqual([]);
    const ownTree = { ...own, includeSubtree: true };
    expect(competenceSubtreeRoots(ownTree, [PARENT])).toEqual([PARENT]);
    expect(
      scopeCoversRequestingUnits(
        ownTree,
        target,
        holder([PARENT], new Map([[PARENT, [PARENT, SECTOR]]])),
      ),
    ).toBe(true);
  });

  it('DEPARTMENT sem unidade não cobre nada', () => {
    expect(scopeCoversRequestingUnits(scope({ scopeType: 'DEPARTMENT' }), target, holder())).toBe(
      false,
    );
    expect(
      competenceSubtreeRoots(scope({ scopeType: 'DEPARTMENT', includeSubtree: true }), []),
    ).toEqual([]);
  });
});
