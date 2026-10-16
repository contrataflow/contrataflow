import type { PermissionCode } from '@contrataflow/types';
import { describe, expect, it } from 'vitest';

import {
  buildEffectivePermissions,
  EffectivePermissionSet,
  grantingAssignments,
  PARTICIPATION_PERMISSIONS,
  subtreeRoots,
} from './effective-permissions.js';
import type { AssignedRole } from './effective-permissions.js';
import type { ScopeType } from './role.js';

/* US-097 — EffectivePermissions (permissions.md §1, §1.1, §1.2, §4): cálculo e cobertura. */

const NOW = new Date('2026-10-16T12:00:00.000Z');
const DAY = 86_400_000;

function assigned(
  scopeType: ScopeType,
  permissions: readonly PermissionCode[],
  overrides: Partial<AssignedRole['assignment']> & { readonly roleActive?: boolean } = {},
): AssignedRole {
  const { roleActive, ...assignment } = overrides;
  return {
    assignment: {
      scopeType,
      scopeOrganizationId: null,
      scopeDepartmentId: null,
      includeSubtree: true,
      validFrom: new Date(NOW.getTime() - DAY),
      validUntil: null,
      revokedAt: null,
      ...assignment,
    },
    role: { isActive: roleActive ?? true, permissions },
  };
}

function build(items: readonly AssignedRole[], own: readonly string[] = ['obras']) {
  const granting = grantingAssignments(items, NOW);
  const subtrees = new Map<string, readonly string[]>([
    ['obras', ['obras', 'projetos']],
    ['saude', ['saude', 'ubs']],
  ]);
  return new EffectivePermissionSet(
    buildEffectivePermissions({
      membershipId: 'm1',
      userId: 'u1',
      granting,
      ownDepartmentIds: own,
      subtrees,
      headOfDepartmentIds: ['obras'],
      now: NOW,
    }),
  );
}

describe('grantingAssignments (permissions.md §1.2)', () => {
  it('só vigentes (validFrom ≤ now < validUntil), não revogadas e de perfil ativo', () => {
    const items = [
      assigned('TENANT', ['PROCESS_VIEW']),
      assigned('TENANT', ['PROCESS_CANCEL'], { validFrom: new Date(NOW.getTime() + DAY) }),
      assigned('TENANT', ['PROCESS_SUSPEND'], { validUntil: NOW }),
      assigned('TENANT', ['PROCESS_ASSIGN'], { revokedAt: new Date(NOW.getTime() - 1) }),
      assigned('TENANT', ['PROCESS_EXPORT'], { roleActive: false }),
      { ...assigned('TENANT', ['AUDIT_VIEW']), role: null },
    ];
    const set = build(items);
    expect(set.has('PROCESS_VIEW')).toBe(true);
    for (const code of [
      'PROCESS_CANCEL',
      'PROCESS_SUSPEND',
      'PROCESS_ASSIGN',
      'PROCESS_EXPORT',
      'AUDIT_VIEW',
    ] as const) {
      expect(set.has(code), code).toBe(false);
    }
  });
});

describe('buildEffectivePermissions — múltiplas atribuições e escopos sobrepostos', () => {
  it('agrupa por escopo idêntico (união), expande subárvore e lotação e ordena', () => {
    const set = build([
      assigned('DEPARTMENT', ['PROCESS_VIEW'], { scopeDepartmentId: 'saude' }),
      assigned('DEPARTMENT', ['PROCESS_CREATE', 'PROCESS_VIEW'], { scopeDepartmentId: 'saude' }),
      assigned('DEPARTMENT', ['PROCESS_FORWARD'], {
        scopeDepartmentId: 'saude',
        includeSubtree: false,
      }),
      assigned('OWN_DEPARTMENTS', ['DFD_CREATE']),
      assigned('ORGANIZATION', ['APPROVAL_DECIDE'], { scopeOrganizationId: 'org-a' }),
    ]);
    expect(set.snapshot.grants).toEqual([
      {
        scope: {
          type: 'DEPARTMENT',
          organizationId: null,
          departmentId: 'saude',
          includeSubtree: false,
          departmentIds: ['saude'],
        },
        permissions: ['PROCESS_FORWARD'],
      },
      {
        scope: {
          type: 'DEPARTMENT',
          organizationId: null,
          departmentId: 'saude',
          includeSubtree: true,
          departmentIds: ['saude', 'ubs'],
        },
        permissions: ['PROCESS_CREATE', 'PROCESS_VIEW'],
      },
      {
        scope: {
          type: 'ORGANIZATION',
          organizationId: 'org-a',
          departmentId: null,
          includeSubtree: false,
          departmentIds: [],
        },
        permissions: ['APPROVAL_DECIDE'],
      },
      {
        scope: {
          type: 'OWN_DEPARTMENTS',
          organizationId: null,
          departmentId: null,
          includeSubtree: true,
          departmentIds: ['obras', 'projetos'],
        },
        permissions: ['DFD_CREATE'],
      },
    ]);
    expect(set.snapshot).toMatchObject({
      membershipId: 'm1',
      userId: 'u1',
      ownDepartmentIds: ['obras'],
      headOfDepartmentIds: ['obras'],
      computedAt: NOW.toISOString(),
    });
  });

  it('subtreeRoots pede só as subárvores necessárias', () => {
    const granting = grantingAssignments(
      [
        assigned('DEPARTMENT', ['PROCESS_VIEW'], { scopeDepartmentId: 'saude' }),
        assigned('DEPARTMENT', ['PROCESS_VIEW'], {
          scopeDepartmentId: 'juridico',
          includeSubtree: false,
        }),
        assigned('OWN_DEPARTMENTS', ['PROCESS_VIEW']),
        assigned('TENANT', ['PROCESS_VIEW']),
      ],
      NOW,
    );
    expect(subtreeRoots(granting, ['obras', 'compras'])).toEqual(['compras', 'obras', 'saude']);
    expect(
      subtreeRoots(grantingAssignments([assigned('TENANT', ['AUDIT_VIEW'])], NOW), ['x']),
    ).toEqual([]);
  });

  it('OWN_DEPARTMENTS sem subárvore cobre só as lotações; unidade sem árvore conhecida, só ela', () => {
    const set = build(
      [assigned('OWN_DEPARTMENTS', ['PROCESS_VIEW'], { includeSubtree: false })],
      ['obras', 'avulsa'],
    );
    expect(set.scopesOf('PROCESS_VIEW')[0]?.departmentIds).toEqual(['avulsa', 'obras']);
    const avulsa = build([assigned('OWN_DEPARTMENTS', ['PROCESS_VIEW'])], ['avulsa']);
    expect(avulsa.scopesOf('PROCESS_VIEW')[0]?.departmentIds).toEqual(['avulsa']);
  });
});

describe('EffectivePermissionSet — cobertura (permissions.md §1.1)', () => {
  const set = build([
    assigned('OWN_DEPARTMENTS', ['PROCESS_VIEW', 'PROCESS_CREATE', 'INBOX_VIEW']),
    assigned('ORGANIZATION', ['PROCESS_CANCEL'], { scopeOrganizationId: 'org-a' }),
    assigned('TENANT', ['PROCESS_EXPORT']),
  ]);

  it('has/scopesOf/coversTenantWide', () => {
    expect(set.has('PROCESS_CREATE')).toBe(true);
    expect(set.has('USER_MANAGE')).toBe(false);
    expect(set.scopesOf('PROCESS_CANCEL').map((scope) => scope.type)).toEqual(['ORGANIZATION']);
    expect(set.coversTenantWide('PROCESS_EXPORT')).toBe(true);
    expect(set.coversTenantWide('PROCESS_CREATE')).toBe(false);
  });

  it('coversDepartment: lotação e subárvore, órgão do escopo, TENANT; não escopável = has', () => {
    expect(set.coversDepartment('PROCESS_CREATE', { id: 'projetos', organizationId: null })).toBe(
      true,
    );
    expect(set.coversDepartment('PROCESS_CREATE', { id: 'saude', organizationId: 'org-a' })).toBe(
      false,
    );
    expect(set.coversDepartment('PROCESS_CANCEL', { id: 'saude', organizationId: 'org-a' })).toBe(
      true,
    );
    expect(set.coversDepartment('PROCESS_CANCEL', { id: 'saude', organizationId: 'org-b' })).toBe(
      false,
    );
    expect(set.coversDepartment('PROCESS_EXPORT', { id: 'qualquer', organizationId: null })).toBe(
      true,
    );
    // INBOX_VIEW não é escopável: o escopo da atribuição não restringe.
    expect(set.coversDepartment('INBOX_VIEW', { id: 'saude', organizationId: null })).toBe(true);
  });

  it('roleCoversProcess: TENANT, órgão do processo ou concessão de unidade coberta', () => {
    const own = { organizationId: null, departmentIds: ['projetos'] };
    const other = { organizationId: 'org-a', departmentIds: ['saude'] };
    expect(set.roleCoversProcess('PROCESS_VIEW', own)).toBe(true);
    expect(set.roleCoversProcess('PROCESS_VIEW', other)).toBe(false);
    expect(set.roleCoversProcess('PROCESS_CANCEL', other)).toBe(true);
    expect(set.roleCoversProcess('PROCESS_CANCEL', { ...other, organizationId: null })).toBe(false);
    expect(set.roleCoversProcess('PROCESS_EXPORT', other)).toBe(true);
    expect(set.roleCoversProcess('INBOX_VIEW', other)).toBe(true);
    expect(set.roleCoversProcess('AUDIT_VIEW', other)).toBe(false);
  });

  it('participationGrants: papel fixo, só do próprio usuário, ativo e não vencido (§4)', () => {
    const target = (role: 'OBSERVER' | 'COLLABORATOR' | 'CONSULTANT', expiresAt: Date | null) => ({
      participations: [{ userId: 'u1', role, expiresAt }],
    });
    expect(set.participationGrants('COMMENT_CREATE', target('OBSERVER', null), NOW)).toBe(true);
    expect(set.participationGrants('DFD_UPDATE', target('OBSERVER', null), NOW)).toBe(false);
    expect(set.participationGrants('DFD_UPDATE', target('COLLABORATOR', null), NOW)).toBe(true);
    expect(
      set.participationGrants(
        'ETP_UPDATE',
        target('CONSULTANT', new Date(NOW.getTime() + DAY)),
        NOW,
      ),
    ).toBe(true);
    expect(set.participationGrants('COMMENT_CREATE', target('OBSERVER', NOW), NOW)).toBe(false);
    expect(
      set.participationGrants(
        'COMMENT_CREATE',
        { participations: [{ userId: 'outro', role: 'OBSERVER', expiresAt: null }] },
        NOW,
      ),
    ).toBe(false);
    for (const role of ['OBSERVER', 'COLLABORATOR', 'CONSULTANT'] as const) {
      for (const forbidden of [
        'PROCESS_FORWARD',
        'PROCESS_RETURN',
        'PROCESS_CLAIM',
        'PROCESS_COMPLETE',
        'PROCESS_CANCEL',
        'APPROVAL_DECIDE',
        'PROCESS_VIEW_CONFIDENTIAL_BUDGET',
      ] as const) {
        expect(PARTICIPATION_PERMISSIONS[role].has(forbidden), `${role} ${forbidden}`).toBe(false);
      }
    }
  });

  it('visibilityScope: os escopos de PROCESS_VIEW expandidos (DEC-024)', () => {
    expect(set.visibilityScope()).toEqual({
      userId: 'u1',
      tenantWide: false,
      organizationIds: [],
      departmentIds: ['obras', 'projetos'],
    });
    const wide = build([
      assigned('TENANT', ['PROCESS_VIEW']),
      assigned('ORGANIZATION', ['PROCESS_VIEW'], { scopeOrganizationId: 'org-a' }),
    ]);
    expect(wide.visibilityScope()).toMatchObject({ tenantWide: true, organizationIds: ['org-a'] });
  });

  it('toMyPermissions: ordem alfabética, escopos sem repetição, sem campos nulos (ME-03)', () => {
    const dto = build([
      assigned('OWN_DEPARTMENTS', ['PROCESS_VIEW']),
      assigned('OWN_DEPARTMENTS', ['PROCESS_VIEW', 'PROCESS_CREATE']),
      assigned('DEPARTMENT', ['PROCESS_VIEW'], { scopeDepartmentId: 'saude' }),
      assigned('ORGANIZATION', ['APPROVAL_DECIDE'], { scopeOrganizationId: 'org-a' }),
    ]).toMyPermissions();
    expect(dto).toEqual({
      permissions: [
        {
          code: 'APPROVAL_DECIDE',
          scopes: [{ type: 'ORGANIZATION', organizationId: 'org-a', includeSubtree: false }],
        },
        { code: 'PROCESS_CREATE', scopes: [{ type: 'OWN_DEPARTMENTS', includeSubtree: true }] },
        {
          code: 'PROCESS_VIEW',
          scopes: [
            { type: 'DEPARTMENT', departmentId: 'saude', includeSubtree: true },
            { type: 'OWN_DEPARTMENTS', includeSubtree: true },
          ],
        },
      ],
      implicit: { headOfDepartmentIds: ['obras'] },
    });
  });
});
