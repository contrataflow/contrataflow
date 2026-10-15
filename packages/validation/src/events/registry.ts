import type { AnyDomainEventDefinition } from './define.js';
import { CatalogItemChanged } from '../catalog/events.js';
import { DocumentTypeChanged } from '../document/events.js';
import {
  OrganizationCreated,
  OrganizationUpdated,
  TenantActivated,
  TenantDeactivated,
  TenantOffboarded,
  TenantProvisioned,
  TenantSettingsChanged,
  TenantSuspended,
} from '../tenancy/events.js';

/**
 * Definições dos eventos de domínio do MVP 1 por `eventType` (V-03 da US-082): espelha
 * `DOMAIN_EVENT_NAMES` de `@contrataflow/types` — um teste reprova nome sem definição ou definição
 * sem nome. Preenchido pelas stories donas de cada evento (events.md), ex.: `ProcessCreated` na
 * US-001.
 */
export const DOMAIN_EVENT_DEFINITIONS: Readonly<Record<string, AnyDomainEventDefinition>> = {
  CatalogItemChanged,
  DocumentTypeChanged,
  OrganizationCreated,
  OrganizationUpdated,
  TenantProvisioned,
  TenantActivated,
  TenantSuspended,
  TenantOffboarded,
  TenantDeactivated,
  TenantSettingsChanged,
};
