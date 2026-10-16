import type { TenantMembershipDto } from '@contrataflow/validation';

import type { MembershipView } from './invitation-ports.js';

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** `TenantMembership` da resposta (USR-01/03/06). O token e o hash nunca saem daqui. */
export function toMembershipDto(view: MembershipView): TenantMembershipDto {
  return {
    id: view.id,
    userId: view.userId,
    name: view.name,
    socialName: view.socialName,
    email: view.email,
    type: view.type,
    status: view.status,
    jobTitle: view.jobTitle,
    registrationNumber: view.registrationNumber,
    expiresAt: iso(view.expiresAt),
    departmentIds: [...view.departmentIds],
    primaryDepartmentId: view.departmentIds[0] ?? null,
    invitedAt: iso(view.invitedAt),
    inviteExpiresAt: view.status === 'INVITED' ? iso(view.inviteExpiresAt) : null,
    activatedAt: iso(view.activatedAt),
    version: view.version,
  };
}
