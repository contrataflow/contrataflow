import { describe, expect, it } from 'vitest';

import type { MembershipReferences } from '#shared/auth/membership-references.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { ApprovalCompetenceService } from './approval-competence.service.js';
import type { RoleAssignmentRepository, RoleRepository } from './ports.js';
import type { IdentityFacade, TenantMember } from '../../identity/application/identity.facade.js';
import type { RoleAssignment } from '../domain/role-assignment.js';
import type { Role } from '../domain/role.js';

/* US-051 · RN-TRAM-47 — detentores competentes de um perfil aprovador (atribuições vigentes). */

const id = (n: number) => `0192f051-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const TENANT = id(1);
const ORG = id(2);
const SEC = id(3);
const SETOR = id(4);
const GABINETE = id(5);
const OUTRA = id(6);
const ROLE = id(7);
const NOW = new Date('2026-10-18T12:00:00.000Z');
const TX = {} as TenantTx;
const target = { organizationId: ORG, departmentIds: [SEC, SETOR] };

const role = (overrides: Partial<Role> = {}) =>
  ({ id: ROLE, isActive: true, ...overrides }) as Role;

let seq = 100;
function assignment(overrides: Partial<RoleAssignment>): RoleAssignment {
  seq += 1;
  return {
    id: id(seq),
    tenantId: TENANT,
    membershipId: id(seq + 500),
    roleId: ROLE,
    scopeType: 'TENANT',
    scopeOrganizationId: null,
    scopeDepartmentId: null,
    includeSubtree: true,
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
    validUntil: null,
    grantedById: id(9),
    reason: null,
    revokedAt: null,
    revokedById: null,
    revocationReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    ...overrides,
  };
}

function service(options: {
  readonly role?: Role | null;
  readonly assignments: readonly RoleAssignment[];
  readonly inactive?: readonly string[];
  readonly expired?: readonly string[];
  readonly own?: Readonly<Record<string, readonly string[]>>;
}) {
  const userOf = (membershipId: string) => `user-${membershipId}`;
  const roles = {
    findById: () => Promise.resolve(options.role === undefined ? role() : options.role),
  } as unknown as RoleRepository;
  const assignments = {
    listByRole: () => Promise.resolve([...options.assignments]),
  } as unknown as RoleAssignmentRepository;
  const identity = {
    membershipUserIds: (_tx: TenantTx, ids: readonly string[]) =>
      Promise.resolve(new Map(ids.map((membershipId) => [membershipId, userOf(membershipId)]))),
    membersInTenant: (_tx: TenantTx, userIds: readonly string[]) =>
      Promise.resolve(
        options.assignments
          .filter((row) => userIds.includes(userOf(row.membershipId)))
          .map((row): TenantMember => ({
            userId: userOf(row.membershipId),
            membershipId: row.membershipId,
            type: 'INTERNAL',
            status: options.inactive?.includes(row.membershipId) ? 'SUSPENDED' : 'ACTIVE',
            expiresAt: options.expired?.includes(row.membershipId)
              ? new Date('2026-06-01T00:00:00.000Z')
              : null,
            roleKeys: [],
          })),
      ),
    departmentsOfUser: (_tx: TenantTx, userId: string) =>
      Promise.resolve([...(options.own?.[userId] ?? [])]),
  } as unknown as IdentityFacade;
  const subtreeCalls: string[][] = [];
  const references = {
    subtreeIds: (_tx: TenantTx, roots: readonly string[]) => {
      subtreeCalls.push([...roots]);
      return Promise.resolve(
        new Map(roots.map((root) => [root, root === GABINETE ? [GABINETE, SEC, SETOR] : [root]])),
      );
    },
  } as unknown as MembershipReferences;
  return {
    competence: new ApprovalCompetenceService(roles, assignments, identity, references),
    userOf,
    subtreeCalls,
  };
}

describe('ApprovalCompetenceService.roleHolders', () => {
  it('só detentores com escopo sobre a unidade solicitante; vínculos inativos/vencidos e atribuições fora do prazo não contam', async () => {
    const tenantWide = assignment({});
    const organization = assignment({ scopeType: 'ORGANIZATION', scopeOrganizationId: ORG });
    const cabinet = assignment({ scopeType: 'DEPARTMENT', scopeDepartmentId: GABINETE });
    const own = assignment({ scopeType: 'OWN_DEPARTMENTS', includeSubtree: false });
    const historical = assignment({ scopeType: 'DEPARTMENT', scopeDepartmentId: OUTRA });
    const revoked = assignment({ revokedAt: new Date('2026-02-01T00:00:00.000Z') });
    const future = assignment({ validFrom: new Date('2026-12-01T00:00:00.000Z') });
    const ended = assignment({ validUntil: new Date('2026-06-01T00:00:00.000Z') });
    const suspended = assignment({});
    const expired = assignment({});
    const { competence, userOf, subtreeCalls } = service({
      assignments: [
        tenantWide,
        organization,
        cabinet,
        own,
        historical,
        revoked,
        future,
        ended,
        suspended,
        expired,
      ],
      inactive: [suspended.membershipId],
      expired: [expired.membershipId],
      own: { [`user-${own.membershipId}`]: [SETOR] },
    });
    expect(await competence.roleHolders(TX, ROLE, target, NOW)).toEqual(
      [tenantWide, organization, cabinet, own].map((row) => userOf(row.membershipId)).sort(),
    );
    // Subárvores só das atribuições que as incluem (o gabinete e a unidade visitada), numa ida só.
    expect(subtreeCalls).toEqual([[GABINETE, OUTRA]]);
  });

  it('perfil inexistente ou inativo, ou sem atribuições: ninguém', async () => {
    expect(
      await service({ role: null, assignments: [assignment({})] }).competence.roleHolders(
        TX,
        ROLE,
        target,
        NOW,
      ),
    ).toEqual([]);
    expect(
      await service({
        role: role({ isActive: false }),
        assignments: [assignment({})],
      }).competence.roleHolders(TX, ROLE, target, NOW),
    ).toEqual([]);
    expect(
      await service({ assignments: [] }).competence.roleHolders(TX, ROLE, target, NOW),
    ).toEqual([]);
  });

  it('o mesmo usuário com duas atribuições aparece uma vez', async () => {
    const first = assignment({});
    const second = assignment({
      membershipId: first.membershipId,
      scopeType: 'ORGANIZATION',
      scopeOrganizationId: ORG,
    });
    const { competence, userOf } = service({ assignments: [first, second] });
    expect(await competence.roleHolders(TX, ROLE, target, NOW)).toEqual([
      userOf(first.membershipId),
    ]);
  });
});
