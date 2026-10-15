import type { MembershipSummaryDto, MyProfileDto } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import { ApiError } from '#shared/errors/api-error.js';

import { IDENTITY_CLOCK, IDENTITY_REPOSITORY } from './ports.js';
import type { Clock, IdentityRepository } from './ports.js';
import { isUsable } from '../domain/tenant-membership.js';
import type { TenantMembership } from '../domain/tenant-membership.js';
import { interfacePreferences } from '../domain/user.js';

/** Projeção de ME-04 de um vínculo (com `usable`/`readOnly` consolidados — RN-IAM-08). */
export function toMembershipSummary(membership: TenantMembership, now: Date): MembershipSummaryDto {
  const access = isUsable(membership, now);
  return {
    membershipId: membership.id,
    tenant: {
      id: membership.tenant.id,
      name: membership.tenant.name,
      status: membership.tenant.status,
    },
    type: membership.type,
    status: membership.status,
    expiresAt: membership.expiresAt?.toISOString() ?? null,
    usable: access.usable,
    readOnly: access.usable && access.readOnly,
  };
}

function currentUserId(): string {
  const userId = requireRequestContext().actor.userId;
  if (!userId) throw new ApiError('UNAUTHENTICATED');
  return userId;
}

/** `ListMyMembershipsQuery` (ME-04): vínculos do próprio usuário em todos os tenants. */
@Injectable()
export class ListMyMembershipsQuery {
  constructor(
    @Inject(IDENTITY_REPOSITORY) private readonly identities: IdentityRepository,
    @Inject(IDENTITY_CLOCK) private readonly clock: Clock,
  ) {}

  async execute(): Promise<MembershipSummaryDto[]> {
    const now = this.clock();
    const memberships = await this.identities.listMemberships(currentUserId());
    return memberships.map((membership) => toMembershipSummary(membership, now));
  }
}

/** ME-01 — perfil do usuário autenticado (api/01-session-me.md), com `version` para o `ETag`. */
@Injectable()
export class GetMyProfileQuery {
  constructor(@Inject(IDENTITY_REPOSITORY) private readonly identities: IdentityRepository) {}

  async execute(): Promise<MyProfileDto> {
    const user = await this.identities.findUserById(currentUserId());
    if (!user) throw new ApiError('UNAUTHENTICATED');
    return {
      id: user.id,
      name: user.name,
      socialName: user.socialName,
      phone: user.phone,
      preferences: interfacePreferences(user),
      version: user.version,
    };
  }
}
