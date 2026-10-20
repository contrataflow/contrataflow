import { describe, expect, it } from 'vitest';

import { RoleAssigned, RoleRevoked } from './events.js';
import {
  assignRoleSchema,
  isLastAdministrativeAssignment,
  revokeRoleAssignmentSchema,
} from './role-assignment.js';

const ROLE = '0192a000-0000-7000-8000-0000000000e5';
const ORG = '0192a000-0000-7000-8000-00000000a0a0';
const DEP = '0192a000-0000-7000-8000-0000000000d1';

const issuesOf = (input: unknown) => {
  const result = assignRoleSchema.safeParse(input);
  expect(result.success).toBe(false);
  return (result.error?.issues ?? []).map((issue) => [
    issue.path.join('.'),
    (issue as { params?: { code?: string } }).params?.code ?? issue.code,
  ]);
};

describe('assignRoleSchema (ROL-11 · RN-IAM-89/93)', () => {
  it('aceita os quatro escopos com o campo do escopo', () => {
    expect(assignRoleSchema.parse({ roleId: ROLE, scopeType: 'TENANT' })).toEqual({
      roleId: ROLE,
      scopeType: 'TENANT',
    });
    expect(
      assignRoleSchema.parse({ roleId: ROLE, scopeType: 'ORGANIZATION', scopeOrganizationId: ORG })
        .scopeOrganizationId,
    ).toBe(ORG);
    expect(
      assignRoleSchema.parse({
        roleId: ROLE,
        scopeType: 'DEPARTMENT',
        scopeDepartmentId: DEP,
        includeSubtree: false,
      }).includeSubtree,
    ).toBe(false);
    expect(assignRoleSchema.parse({ roleId: ROLE, scopeType: 'OWN_DEPARTMENTS' }).scopeType).toBe(
      'OWN_DEPARTMENTS',
    );
  });

  it('V-01/V-02: obrigatórios, condicionais e exclusivos', () => {
    expect(assignRoleSchema.safeParse({}).success).toBe(false);
    expect(issuesOf({ roleId: ROLE, scopeType: 'ORGANIZATION' })).toEqual([
      ['scopeOrganizationId', 'CONDITIONAL_REQUIRED'],
    ]);
    expect(issuesOf({ roleId: ROLE, scopeType: 'DEPARTMENT' })).toEqual([
      ['scopeDepartmentId', 'CONDITIONAL_REQUIRED'],
    ]);
    expect(
      issuesOf({
        roleId: ROLE,
        scopeType: 'TENANT',
        scopeOrganizationId: ORG,
        scopeDepartmentId: DEP,
      }),
    ).toEqual([
      ['scopeOrganizationId', 'NOT_ALLOWED'],
      ['scopeDepartmentId', 'NOT_ALLOWED'],
    ]);
    expect(assignRoleSchema.safeParse({ roleId: ROLE, scopeType: 'OUTRO' }).success).toBe(false);
  });

  it('V-04: término posterior ao início quando os dois vêm no corpo', () => {
    expect(
      issuesOf({
        roleId: ROLE,
        scopeType: 'TENANT',
        validFrom: '2026-10-16T12:00:00Z',
        validUntil: '2026-10-16T12:00:00Z',
      }),
    ).toEqual([['validUntil', 'OUT_OF_RANGE']]);
    expect(
      assignRoleSchema.safeParse({
        roleId: ROLE,
        scopeType: 'TENANT',
        validFrom: '2026-10-16T12:00:00Z',
        validUntil: '2026-10-17T12:00:00Z',
      }).success,
    ).toBe(true);
  });

  it('motivo da revogação até 500 caracteres', () => {
    expect(revokeRoleAssignmentSchema.parse({ reason: '  fim  ' })).toEqual({ reason: 'fim' });
    expect(revokeRoleAssignmentSchema.parse({})).toEqual({});
    expect(revokeRoleAssignmentSchema.safeParse({ reason: 'x'.repeat(501) }).success).toBe(false);
  });
});

describe('isLastAdministrativeAssignment (FA-05 · POL-16 na tela)', () => {
  const now = new Date('2026-10-16T12:00:00Z');
  const admin = {
    id: 'a',
    isAdministrative: true,
    status: 'ACTIVE' as const,
    validFrom: '2026-01-01T00:00:00Z',
    validUntil: null,
  };

  it('a única administrativa vigente é a última', () => {
    expect(isLastAdministrativeAssignment(admin, [admin], now)).toBe(true);
    expect(isLastAdministrativeAssignment(admin, [admin, { ...admin, id: 'b' }], now)).toBe(false);
    // Outra administrativa futura, vencida ou revogada não conta.
    for (const other of [
      { ...admin, id: 'c', validFrom: '2026-12-01T00:00:00Z' },
      { ...admin, id: 'd', validUntil: '2026-02-01T00:00:00Z' },
      { ...admin, id: 'e', status: 'REVOKED' as const },
      { ...admin, id: 'f', isAdministrative: false },
    ]) {
      expect(isLastAdministrativeAssignment(admin, [admin, other], now)).toBe(true);
    }
    expect(isLastAdministrativeAssignment({ ...admin, isAdministrative: false }, [], now)).toBe(
      false,
    );
  });
});

describe('RoleAssigned/RoleRevoked (events.md §4)', () => {
  it('routing keys e payloads', () => {
    expect(
      RoleAssigned.resolve({
        roleAssignmentId: ROLE,
        membershipId: ROLE,
        roleId: ROLE,
        scopeType: 'DEPARTMENT',
        scopeId: DEP,
      }).routingKey,
    ).toBe('role.assigned');
    expect(() =>
      RoleAssigned.resolve({
        roleAssignmentId: ROLE,
        membershipId: ROLE,
        roleId: ROLE,
        scopeType: 'X',
      }),
    ).toThrow();
    expect(
      RoleRevoked.resolve({ roleAssignmentId: ROLE, membershipId: ROLE, roleId: ROLE }).routingKey,
    ).toBe('role.revoked');
  });
});
