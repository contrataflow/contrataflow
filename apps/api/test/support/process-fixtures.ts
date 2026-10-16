// Carga dos testes de rota da criação de processo (US-001) em memória: os seeders reais do
// provisionamento (catálogos, perfis, tipos de documento e o workflow padrão DEC-015), a estrutura
// do Background do Gherkin (órgão, Secretaria de Obras/Setor de Manutenção, Secretaria de Saúde) e
// acesso aos adaptadores em memória. Fica fora de `src/modules` porque os specs de um módulo não
// importam internos de outro (DEC-041 · dependency-cruiser).
import request from 'supertest';

import { CATALOG_CLOCK } from '#modules/catalog/application/catalog-ports.js';
import { InMemoryCatalogItemRepository } from '#modules/catalog/infrastructure/in-memory-catalog-item.repository.js';
import { InMemoryNumberSequenceRepository } from '#modules/catalog/infrastructure/in-memory-number-sequence.repository.js';
import { InMemoryProcessRepository } from '#modules/process/infrastructure/in-memory-process.repository.js';
import { TENANT_SETTINGS_REPOSITORY } from '#modules/tenancy/application/settings-ports.js';
import { InMemoryOrganizationRepository } from '#modules/tenancy/infrastructure/in-memory-organization.repository.js';
import type { InMemoryTenantSettingsRepository } from '#modules/tenancy/infrastructure/in-memory-tenant-settings.repository.js';
import { TIMELINE_ENTRY_STORE } from '#modules/timeline/application/ports.js';
import type { InMemoryTimelineEntryStore } from '#modules/timeline/infrastructure/in-memory-timeline-entry.store.js';
import { runAsSystem } from '#shared/context/request-context.js';
import { TenantSeederRegistry } from '#shared/tenancy/tenant-seeding.js';

import type { TestApi } from './api-test-app.js';
import { seedDepartment, seedOrganizations } from './structure-fixtures.js';

/** Seeders do provisionamento que a criação de processo pressupõe (US-104/094/061/042). */
export const PROCESS_PREREQUISITE_SEEDERS = [
  'catalog.items',
  'access.defaultRoles',
  'document.systemTypes',
  'workflow.seedWorkflows',
] as const;

export async function runTenantSeeders(
  api: TestApi,
  tenantId: string,
  keys: readonly string[] = PROCESS_PREREQUISITE_SEEDERS,
): Promise<void> {
  const registry = api.app.get(TenantSeederRegistry);
  for (const key of keys) {
    const seeder = registry.all().find((candidate) => candidate.key === key);
    if (!seeder) throw new Error(`Seeder ${key} não registrado.`);
    await runAsSystem({ name: 'Provisionamento de tenant', tenantId }, () =>
      seeder.seed({ tenantId, slug: 'teste', now: new Date(), request: null }),
    );
  }
}

export interface ProcessStructure {
  readonly organizationId: string;
  readonly obras: string;
  readonly manutencao: string;
  readonly pavimentacao: string;
  readonly saude: string;
  readonly posto: string;
}

/** Órgão principal e as unidades do Background (US-001) no tenant. */
export function seedProcessStructure(
  api: TestApi,
  tenantId: string,
  ids: ProcessStructure & { readonly shortName: string; readonly cnpj: string },
): void {
  seedOrganizations(api, {
    tenantId,
    id: ids.organizationId,
    shortName: ids.shortName,
    cnpj: ids.cnpj,
  });
  api.app
    .get(InMemoryOrganizationRepository, { strict: false })
    .setPrimary(tenantId, ids.organizationId);
  const base = { tenantId, organizationId: ids.organizationId };
  const obras = seedDepartment(api, { ...base, id: ids.obras, name: 'Secretaria de Obras' });
  seedDepartment(api, { ...base, id: ids.manutencao, name: 'Setor de Manutenção', parent: obras });
  seedDepartment(api, {
    ...base,
    id: ids.pavimentacao,
    name: 'Setor de Pavimentação',
    parent: obras,
  });
  const saude = seedDepartment(api, { ...base, id: ids.saude, name: 'Secretaria de Saúde' });
  seedDepartment(api, { ...base, id: ids.posto, name: 'Posto de Saúde Central', parent: saude });
}

/** Id do item ATIVO do catálogo do tenant pelo código (repositório em memória). */
export function catalogItemId(
  api: TestApi,
  tenantId: string,
  catalogType: string,
  code: string,
): string {
  const item = api.app
    .get(InMemoryCatalogItemRepository, { strict: false })
    .snapshot()
    .find(
      (candidate) =>
        candidate.tenantId === tenantId &&
        candidate.catalogType === catalogType &&
        candidate.code === code,
    );
  if (!item) throw new Error(`${catalogType}/${code} ausente no tenant ${tenantId}`);
  return item.id;
}

export function processRepositoryOf(api: TestApi): InMemoryProcessRepository {
  return api.app.get(InMemoryProcessRepository, { strict: false });
}

export function numberSequencesOf(api: TestApi): InMemoryNumberSequenceRepository {
  return api.app.get(InMemoryNumberSequenceRepository, { strict: false });
}

export function tenantSettingsOf(api: TestApi): InMemoryTenantSettingsRepository {
  return api.app.get<InMemoryTenantSettingsRepository>(TENANT_SETTINGS_REPOSITORY, {
    strict: false,
  });
}

export function timelineRowsOf(api: TestApi): InMemoryTimelineEntryStore['rows'] {
  return api.app.get<InMemoryTimelineEntryStore>(TIMELINE_ENTRY_STORE, { strict: false }).rows;
}

/** `GET /api/v1/...` autenticado no tenant. */
export function getAs(api: TestApi, path: string, subject: string, tenantId: string) {
  return request(api.server)
    .get(`/api/v1${path}`)
    .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
    .set('X-Tenant-Id', tenantId);
}

/** Relógio da numeração (o spec de `process` não importa internos do `catalog` — DEC-041). */
export { CATALOG_CLOCK };
