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

/*
 * Eventos do agregado `Organization` (events.md §4 · US-101): gravados no commit da criação e da
 * atualização do órgão, com o `tenantId` do contexto da requisição.
 */

export const OrganizationCreated = defineDomainEvent({
  eventType: 'OrganizationCreated',
  eventVersion: 1,
  aggregateType: 'Organization',
  payload: z.strictObject({ organizationId: z.uuid() }),
  routingKey: 'organization.created',
});

export const OrganizationUpdated = defineDomainEvent({
  eventType: 'OrganizationUpdated',
  eventVersion: 1,
  aggregateType: 'Organization',
  payload: z.strictObject({
    organizationId: z.uuid(),
    changedFields: z.array(z.string().min(1).max(60)).max(40),
  }),
  routingKey: 'organization.updated',
});

/*
 * Configurações do tenant (events.md §4 · US-103): um único evento por requisição `PATCH /settings`,
 * com as chaves alteradas. O `aggregateId` é o tenant do contexto.
 */

export const TenantSettingsChanged = defineDomainEvent({
  eventType: 'TenantSettingsChanged',
  eventVersion: 1,
  aggregateType: 'Tenant',
  payload: z.strictObject({ keys: z.array(z.string().min(1).max(120)).min(1).max(100) }),
  routingKey: 'tenant.settings_changed',
});
