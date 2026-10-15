import type { AnyDomainEventDefinition } from './define.js';
import { RoleCreated, RoleUpdated } from '../access/events.js';
import { HolidayChanged } from '../calendar/events.js';
import { CatalogItemChanged } from '../catalog/events.js';
import { DocumentTypeChanged } from '../document/events.js';
import {
  DepartmentCreated,
  DepartmentDeactivated,
  DepartmentMoved,
  DepartmentUpdated,
} from '../organization/events.js';
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
import {
  WorkflowCreated,
  WorkflowVersionPublished,
  WorkflowVersionRetired,
} from '../workflow/events.js';

/**
 * Definições dos eventos de domínio do MVP 1 por `eventType` (V-03 da US-082): espelha
 * `DOMAIN_EVENT_NAMES` de `@contrataflow/types` — um teste reprova nome sem definição ou definição
 * sem nome. Preenchido pelas stories donas de cada evento (events.md), ex.: `ProcessCreated` na
 * US-001.
 */
export const DOMAIN_EVENT_DEFINITIONS: Readonly<Record<string, AnyDomainEventDefinition>> = {
  CatalogItemChanged,
  DepartmentCreated,
  DepartmentDeactivated,
  DepartmentMoved,
  DepartmentUpdated,
  HolidayChanged,
  DocumentTypeChanged,
  OrganizationCreated,
  OrganizationUpdated,
  RoleCreated,
  RoleUpdated,
  TenantProvisioned,
  TenantActivated,
  TenantSuspended,
  TenantOffboarded,
  TenantDeactivated,
  TenantSettingsChanged,
  WorkflowCreated,
  WorkflowVersionPublished,
  WorkflowVersionRetired,
};
