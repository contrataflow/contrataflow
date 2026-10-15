import { maskEmail } from '@contrataflow/validation';
import type {
  PlatformTenantDetailDto,
  PlatformTenantDto,
  PlatformTenantSummaryDto,
  ProvisionTenantResultDto,
} from '@contrataflow/validation';

import type { FirstAdminInvitation } from '#shared/tenancy/tenant-seeding.js';

import type { ProvisioningChecklist } from '../domain/seeding-plan.js';
import type { Tenant } from '../domain/tenant.js';

const iso = (value: Date | null) => value?.toISOString() ?? null;

export function toTenantSummaryDto(tenant: Tenant): PlatformTenantSummaryDto {
  return {
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    type: tenant.type,
    status: tenant.status,
    stateCode: tenant.stateCode,
    plan: tenant.plan,
    activatedAt: iso(tenant.activatedAt),
    suspendedAt: iso(tenant.suspendedAt),
  };
}

/** O motivo de suspensão nunca sai (RN-TEN-11): só `hasSuspensionReason`. */
export function toTenantDto(tenant: Tenant): PlatformTenantDto {
  return {
    ...toTenantSummaryDto(tenant),
    legalName: tenant.legalName,
    ibgeCityCode: tenant.ibgeCityCode,
    timezone: tenant.timezone,
    locale: tenant.locale,
    primaryOrganizationId: tenant.primaryOrganizationId,
    deactivatedAt: iso(tenant.deactivatedAt),
    offboardingStartedAt: iso(tenant.offboardingStartedAt),
    hasSuspensionReason: tenant.suspensionReason !== null,
    createdAt: tenant.createdAt.toISOString(),
    updatedAt: tenant.updatedAt.toISOString(),
    version: tenant.version,
  };
}

export function toChecklistDto(checklist: ProvisioningChecklist) {
  return {
    complete: checklist.complete,
    steps: checklist.steps.map((step) => ({
      key: step.key,
      status: step.status,
      version: step.version,
      ...(step.details === undefined ? {} : { details: { ...step.details } }),
    })),
  };
}

export function toTenantDetailDto(
  tenant: Tenant,
  checklist: ProvisioningChecklist,
): PlatformTenantDetailDto {
  return { ...toTenantDto(tenant), provisioning: toChecklistDto(checklist) };
}

export function toProvisionResultDto(
  tenant: Tenant,
  checklist: ProvisioningChecklist,
  firstAdmin: FirstAdminInvitation | null,
  requestedEmail: string,
): ProvisionTenantResultDto {
  return {
    ...toTenantDetailDto(tenant, checklist),
    firstAdmin: {
      email: maskEmail(firstAdmin?.email ?? requestedEmail),
      membershipStatus: firstAdmin?.membershipStatus ?? null,
      invitationDispatched: firstAdmin?.invitationDispatched ?? false,
    },
  };
}
