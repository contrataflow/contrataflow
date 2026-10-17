import type { AnyDomainEventDefinition } from './define.js';
import { RoleAssigned, RoleCreated, RoleRevoked, RoleUpdated } from '../access/events.js';
import {
  AiGenerationCompleted,
  AiGenerationFailed,
  AiGenerationRequested,
  AiUsageThresholdReached,
} from '../ai/events.js';
import { HolidayChanged } from '../calendar/events.js';
import { CatalogItemChanged } from '../catalog/events.js';
import {
  DocumentApproved,
  DocumentCanceled,
  DocumentCreated,
  DocumentFinalized,
  DocumentRejected,
  DocumentReopened,
  DocumentReturned,
  DocumentSubmitted,
  DocumentTypeChanged,
  DocumentVersionCreated,
  TemplateVersionPublished,
  TemplateVersionRetired,
} from '../document/events.js';
import {
  MembershipActivated,
  MembershipReactivated,
  MembershipRevoked,
  MembershipSuspended,
  MembershipUpdated,
  UserInvited,
} from '../identity/events.js';
import {
  DepartmentCreated,
  DepartmentDeactivated,
  DepartmentMoved,
  DepartmentUpdated,
} from '../organization/events.js';
import { ProcessCreated } from '../process/events.js';
import { SupplierCreated, SupplierUpdated } from '../supplier/events.js';
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
  WorkflowDefaultChanged,
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
  AiGenerationRequested,
  AiGenerationCompleted,
  AiGenerationFailed,
  AiUsageThresholdReached,
  CatalogItemChanged,
  DepartmentCreated,
  DepartmentDeactivated,
  DepartmentMoved,
  DepartmentUpdated,
  HolidayChanged,
  DocumentTypeChanged,
  MembershipActivated,
  MembershipUpdated,
  MembershipSuspended,
  MembershipReactivated,
  MembershipRevoked,
  OrganizationCreated,
  OrganizationUpdated,
  ProcessCreated,
  SupplierCreated,
  SupplierUpdated,
  RoleCreated,
  RoleUpdated,
  RoleAssigned,
  RoleRevoked,
  TenantProvisioned,
  TenantActivated,
  TenantSuspended,
  TenantOffboarded,
  TenantDeactivated,
  TenantSettingsChanged,
  UserInvited,
  WorkflowCreated,
  WorkflowVersionPublished,
  WorkflowVersionRetired,
  WorkflowDefaultChanged,
  TemplateVersionPublished,
  TemplateVersionRetired,
  DocumentCreated,
  DocumentVersionCreated,
  DocumentSubmitted,
  DocumentFinalized,
  DocumentApproved,
  DocumentReturned,
  DocumentRejected,
  DocumentReopened,
  DocumentCanceled,
};
