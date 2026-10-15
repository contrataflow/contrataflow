import { z } from 'zod';

import { defineDomainEvent } from '../events/define.js';

/*
 * Eventos do agregado `Tenant` (events.md §4 · US-099), gravados pela plataforma (`cf_platform`)
 * com `tenantId` = o tenant afetado. Ativação e suspensão invalidam o cache de status (o caso de uso
 * também remove a chave diretamente após o commit).
 */

const tenantPayload = z.strictObject({ tenantId: z.uuid() });

export const TenantProvisioned = defineDomainEvent({
  eventType: 'TenantProvisioned',
  eventVersion: 1,
  aggregateType: 'Tenant',
  payload: z.strictObject({
    tenantId: z.uuid(),
    slug: z.string().min(3).max(63),
    primaryOrganizationId: z.uuid().nullable(),
  }),
  routingKey: 'tenant.provisioned',
});

export const TenantActivated = defineDomainEvent({
  eventType: 'TenantActivated',
  eventVersion: 1,
  aggregateType: 'Tenant',
  payload: tenantPayload,
  routingKey: 'tenant.activated',
});

export const TenantSuspended = defineDomainEvent({
  eventType: 'TenantSuspended',
  eventVersion: 1,
  aggregateType: 'Tenant',
  payload: tenantPayload,
  routingKey: 'tenant.suspended',
});

export const TenantOffboarded = defineDomainEvent({
  eventType: 'TenantOffboarded',
  eventVersion: 1,
  aggregateType: 'Tenant',
  payload: z.strictObject({ tenantId: z.uuid(), offboardingEndsAt: z.iso.datetime().nullable() }),
  routingKey: 'tenant.offboarded',
});

export const TenantDeactivated = defineDomainEvent({
  eventType: 'TenantDeactivated',
  eventVersion: 1,
  aggregateType: 'Tenant',
  payload: tenantPayload,
  routingKey: 'tenant.deactivated',
});
