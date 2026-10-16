import type { PermissionCode } from '@contrataflow/types';
import { describe, expect, it } from 'vitest';

import {
  AssignmentAlreadyRevokedError,
  AssignmentValidationError,
  escalatedPermissions,
  externalAssignmentForbidden,
  grantRoleAssignment,
  isAdministrativeRole,
  isEffective,
  revokeRoleAssignment,
  sameAssignment,
  scopeCovers,
  TENANT_SCOPE,
  violatesSelfProtection,
} from './role-assignment.js';
import type {
  AssignmentScope,
  DepartmentLookup,
  GrantContext,
  GrantInput,
  ScopedGrant,
} from './role-assignment.js';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const DAY = 86_400_000;
const ORG_A = '0192a000-0000-7000-8000-00000000a0a0';
const ORG_B = '0192a000-0000-7000-8000-00000000b0b0';
/** Árvore: SEC (raiz de ORG_A) → SETOR → NUCLEO; OUTRA é raiz de ORG_B. */
const SEC = '0192a000-0000-7000-8000-0000000000d1';
const SETOR = '0192a000-0000-7000-8000-0000000000d2';
const NUCLEO = '0192a000-0000-7000-8000-0000000000d3';
const OUTRA = '0192a000-0000-7000-8000-0000000000d4';

const tree: DepartmentLookup = (id) =>
  ({
    [SEC]: { organizationId: ORG_A, pathIds: [SEC] },
    [SETOR]: { organizationId: ORG_A, pathIds: [SEC, SETOR] },
    [NUCLEO]: { organizationId: ORG_A, pathIds: [SEC, SETOR, NUCLEO] },
    [OUTRA]: { organizationId: ORG_B, pathIds: [OUTRA] },
  })[id];

const tenant = (): AssignmentScope => TENANT_SCOPE;
const organization = (id: string): AssignmentScope => ({
  scopeType: 'ORGANIZATION',
  scopeOrganizationId: id,
  scopeDepartmentId: null,
  includeSubtree: true,
});
const department = (id: string, includeSubtree = true): AssignmentScope => ({
  scopeType: 'DEPARTMENT',
  scopeOrganizationId: null,
  scopeDepartmentId: id,
  includeSubtree,
});
const own = (includeSubtree = true): AssignmentScope => ({
  scopeType: 'OWN_DEPARTMENTS',
  scopeOrganizationId: null,
  scopeDepartmentId: null,
  includeSubtree,
});

const internal: GrantContext = {
  id: '0192a000-0000-7000-8000-0000000000e1',
  tenantId: '0192a000-0000-7000-8000-0000000000e2',
  now: NOW,
  userId: '0192a000-0000-7000-8000-0000000000e3',
  membership: { type: 'INTERNAL', expiresAt: null },
};
const base: GrantInput = {
  membershipId: '0192a000-0000-7000-8000-0000000000e4',
  roleId: '0192a000-0000-7000-8000-0000000000e5',
  scopeType: 'TENANT',
};

function validationErrorsOf(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    if (error instanceof AssignmentValidationError) return error.errors;
    throw error;
  }
  throw new Error('esperava AssignmentValidationError');
}

describe('RoleAssignment.grant (RN-IAM-89/93)', () => {
  it('padrões: validFrom = agora, sem término, versão 1, ninguém revogou', () => {
    const assignment = grantRoleAssignment(base, internal);
    expect(assignment).toMatchObject({
      scopeType: 'TENANT',
      scopeOrganizationId: null,
      scopeDepartmentId: null,
      includeSubtree: true,
      validFrom: NOW,
      validUntil: null,
      grantedById: internal.userId,
      revokedAt: null,
      version: 1,
    });
  });

  it('DEPARTMENT/OWN_DEPARTMENTS respeitam includeSubtree (padrão true); demais gravam true', () => {
    expect(
      grantRoleAssignment({ ...base, scopeType: 'DEPARTMENT', scopeDepartmentId: SEC }, internal)
        .includeSubtree,
    ).toBe(true);
    expect(
      grantRoleAssignment(
        { ...base, scopeType: 'DEPARTMENT', scopeDepartmentId: SEC, includeSubtree: false },
        internal,
      ).includeSubtree,
    ).toBe(false);
    expect(
      grantRoleAssignment(
        { ...base, scopeType: 'OWN_DEPARTMENTS', includeSubtree: false },
        internal,
      ).includeSubtree,
    ).toBe(false);
    expect(
      grantRoleAssignment(
        {
          ...base,
          scopeType: 'ORGANIZATION',
          scopeOrganizationId: ORG_A,
          includeSubtree: false,
        },
        internal,
      ).includeSubtree,
    ).toBe(true);
  });

  it('V-02: órgão/unidade obrigatórios e exclusivos do escopo', () => {
    expect(
      validationErrorsOf(() =>
        grantRoleAssignment({ ...base, scopeType: 'ORGANIZATION' }, internal),
      ),
    ).toEqual([
      expect.objectContaining({ field: 'scopeOrganizationId', code: 'CONDITIONAL_REQUIRED' }),
    ]);
    expect(
      validationErrorsOf(() => grantRoleAssignment({ ...base, scopeType: 'DEPARTMENT' }, internal)),
    ).toEqual([
      expect.objectContaining({ field: 'scopeDepartmentId', code: 'CONDITIONAL_REQUIRED' }),
    ]);
    expect(
      validationErrorsOf(() =>
        grantRoleAssignment(
          { ...base, scopeOrganizationId: ORG_A, scopeDepartmentId: SEC },
          internal,
        ),
      ).map((error) => [error.field, error.code]),
    ).toEqual([
      ['scopeOrganizationId', 'NOT_ALLOWED'],
      ['scopeDepartmentId', 'NOT_ALLOWED'],
    ]);
  });

  it('V-04: término depois do início; externo não passa da validade do vínculo', () => {
    expect(
      validationErrorsOf(() => grantRoleAssignment({ ...base, validUntil: NOW }, internal)),
    ).toEqual([expect.objectContaining({ field: 'validUntil', code: 'OUT_OF_RANGE' })]);
    const external: GrantContext = {
      ...internal,
      membership: { type: 'EXTERNAL', expiresAt: new Date(NOW.getTime() + 30 * DAY) },
    };
    expect(
      validationErrorsOf(() =>
        grantRoleAssignment({ ...base, validUntil: new Date(NOW.getTime() + 31 * DAY) }, external),
      ),
    ).toEqual([expect.objectContaining({ field: 'validUntil', code: 'OUT_OF_RANGE' })]);
    expect(
      validationErrorsOf(() =>
        grantRoleAssignment({ ...base, validFrom: new Date(NOW.getTime() + 30 * DAY) }, external),
      ),
    ).toEqual([expect.objectContaining({ field: 'validFrom', code: 'OUT_OF_RANGE' })]);
    // No limite exato e sem término: aceitos (o vínculo vencido encerra o acesso).
    expect(
      grantRoleAssignment({ ...base, validUntil: new Date(NOW.getTime() + 30 * DAY) }, external)
        .validUntil,
    ).toEqual(new Date(NOW.getTime() + 30 * DAY));
    expect(grantRoleAssignment(base, external).validUntil).toBeNull();
    // Interno não tem limite.
    expect(
      grantRoleAssignment({ ...base, validUntil: new Date(NOW.getTime() + 900 * DAY) }, internal)
        .validUntil,
    ).not.toBeNull();
  });

  it('FA-02: vigência futura é aceita e só concede a partir de validFrom', () => {
    const future = grantRoleAssignment(
      { ...base, validFrom: new Date(NOW.getTime() + DAY) },
      internal,
    );
    expect(isEffective(future, NOW)).toBe(false);
    expect(isEffective(future, new Date(NOW.getTime() + DAY))).toBe(true);
    const bounded = grantRoleAssignment(
      { ...base, validUntil: new Date(NOW.getTime() + DAY) },
      internal,
    );
    expect(isEffective(bounded, new Date(NOW.getTime() + DAY))).toBe(false);
  });
});

describe('RoleAssignment.revoke (RN-IAM-95)', () => {
  it('grava quando, quem e o motivo (vazio vira null); nova versão; não revoga duas vezes', () => {
    const assignment = grantRoleAssignment(base, internal);
    const later = new Date(NOW.getTime() + DAY);
    const revoked = revokeRoleAssignment(assignment, {
      now: later,
      userId: 'u',
      reason: '  fim  ',
    });
    expect(revoked).toMatchObject({
      revokedAt: later,
      revokedById: 'u',
      revocationReason: 'fim',
      version: 2,
    });
    expect(isEffective(revoked, later)).toBe(false);
    expect(
      revokeRoleAssignment(assignment, { now: later, userId: 'u', reason: '   ' }).revocationReason,
    ).toBeNull();
    expect(
      revokeRoleAssignment(assignment, { now: later, userId: 'u', reason: undefined })
        .revocationReason,
    ).toBeNull();
    expect(() => revokeRoleAssignment(revoked, { now: later, userId: 'u', reason: null })).toThrow(
      AssignmentAlreadyRevokedError,
    );
  });

  it('RN-IAM-94: mesma atribuição = vínculo, perfil, escopo, órgão e unidade', () => {
    const a = grantRoleAssignment(
      { ...base, scopeType: 'DEPARTMENT', scopeDepartmentId: SEC },
      internal,
    );
    expect(sameAssignment(a, { ...a, includeSubtree: false } as typeof a)).toBe(true);
    expect(sameAssignment(a, { ...a, scopeDepartmentId: SETOR })).toBe(false);
    expect(sameAssignment(a, { ...a, roleId: 'x' })).toBe(false);
  });
});

describe('POL-13 — escopo concedido cobre o pedido (matriz de escopos)', () => {
  it.each<[string, AssignmentScope, AssignmentScope, boolean]>([
    ['TENANT cobre tudo', tenant(), department(NUCLEO), true],
    ['TENANT cobre TENANT', tenant(), tenant(), true],
    ['órgão não cobre TENANT', organization(ORG_A), tenant(), false],
    ['órgão cobre o mesmo órgão', organization(ORG_A), organization(ORG_A), true],
    ['órgão não cobre outro órgão', organization(ORG_A), organization(ORG_B), false],
    ['órgão cobre unidade dele', organization(ORG_A), department(NUCLEO), true],
    ['órgão não cobre unidade de outro órgão', organization(ORG_A), department(OUTRA), false],
    ['órgão não cobre OWN_DEPARTMENTS', organization(ORG_A), own(), false],
    ['unidade cobre a si', department(SETOR), department(SETOR), true],
    ['unidade com subárvore cobre descendente', department(SEC), department(NUCLEO), true],
    [
      'unidade sem subárvore não cobre descendente',
      department(SEC, false),
      department(SETOR),
      false,
    ],
    [
      'unidade sem subárvore não cobre a si com subárvore',
      department(SETOR, false),
      department(SETOR),
      false,
    ],
    [
      'unidade sem subárvore cobre a si sem subárvore',
      department(SETOR, false),
      department(SETOR, false),
      true,
    ],
    ['unidade não cobre a superior', department(SETOR), department(SEC), false],
    ['unidade não cobre órgão', department(SEC), organization(ORG_A), false],
    ['unidade não cobre unidade desconhecida', department(SEC), department('desconhecida'), false],
    ['OWN cobre OWN', own(), own(), true],
    ['OWN sem subárvore não cobre OWN com subárvore', own(false), own(true), false],
    ['OWN sem subárvore cobre OWN sem subárvore', own(false), own(false), true],
    ['OWN não cobre unidade', own(), department(SEC), false],
  ])('%s', (_name, granted, requested, expected) => {
    expect(scopeCovers(granted, requested, tree)).toBe(expected);
  });

  it('órgão pedindo unidade inexistente não cobre', () => {
    expect(scopeCovers(organization(ORG_A), department('x'), () => undefined)).toBe(false);
  });

  const grant = (scope: AssignmentScope, ...codes: PermissionCode[]): ScopedGrant => ({
    scope,
    permissions: new Set(codes),
  });

  it('ADMIN_ORGAO é isento; os demais só atribuem o que têm num escopo que cubra o pedido', () => {
    const required: PermissionCode[] = ['PROCESS_VIEW', 'APPROVAL_DECIDE'];
    expect(
      escalatedPermissions(required, tenant(), { isTenantAdmin: true, grants: [] }, tree),
    ).toEqual([]);
    const actor = {
      isTenantAdmin: false,
      grants: [
        grant(organization(ORG_A), 'PROCESS_VIEW'),
        grant(department(SETOR), 'APPROVAL_DECIDE'),
      ],
    };
    expect(escalatedPermissions(required, department(NUCLEO), actor, tree)).toEqual([]);
    expect(escalatedPermissions(required, department(SEC), actor, tree)).toEqual([
      'APPROVAL_DECIDE',
    ]);
    expect(escalatedPermissions(required, tenant(), actor, tree)).toEqual(required);
  });
});

describe('POL-15/16', () => {
  it('externo só recebe perfil com allowExternalAssignment', () => {
    expect(externalAssignmentForbidden('EXTERNAL', { allowExternalAssignment: false })).toBe(true);
    expect(externalAssignmentForbidden('EXTERNAL', { allowExternalAssignment: true })).toBe(false);
    expect(externalAssignmentForbidden('INTERNAL', { allowExternalAssignment: false })).toBe(false);
  });

  it('perfil administrativo = concede gestão de acessos', () => {
    expect(isAdministrativeRole(['PROCESS_VIEW', 'ROLE_ASSIGN'])).toBe(true);
    expect(isAdministrativeRole(['USER_MANAGE'])).toBe(true);
    expect(isAdministrativeRole(['PROCESS_VIEW', 'USER_VIEW', 'ROLE_VIEW'])).toBe(false);
  });

  it('autoproteção: só a própria e última atribuição administrativa', () => {
    const input = {
      targetMembershipId: 'm1',
      actorMembershipId: 'm1',
      targetIsAdministrative: true,
      otherAdministrativeEffective: 0,
    };
    expect(violatesSelfProtection(input)).toBe(true);
    expect(violatesSelfProtection({ ...input, otherAdministrativeEffective: 1 })).toBe(false);
    expect(violatesSelfProtection({ ...input, actorMembershipId: 'm2' })).toBe(false);
    expect(violatesSelfProtection({ ...input, targetIsAdministrative: false })).toBe(false);
  });
});
