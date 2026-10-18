// Carga dos testes de rota da criação de processo (US-001) em memória: os seeders reais do
// provisionamento (catálogos, perfis, tipos de documento e o workflow padrão DEC-015), a estrutura
// do Background do Gherkin (órgão, Secretaria de Obras/Setor de Manutenção, Secretaria de Saúde) e
// acesso aos adaptadores em memória. Fica fora de `src/modules` porque os specs de um módulo não
// importam internos de outro (DEC-041 · dependency-cruiser).
import request from 'supertest';

import { CATALOG_CLOCK } from '#modules/catalog/application/catalog-ports.js';
import { InMemoryCatalogItemRepository } from '#modules/catalog/infrastructure/in-memory-catalog-item.repository.js';
import { InMemoryNumberSequenceRepository } from '#modules/catalog/infrastructure/in-memory-number-sequence.repository.js';
import { createAttachment, markAvailable } from '#modules/files/domain/attachment.js';
import type { Attachment } from '#modules/files/domain/attachment.js';
import { InMemoryAttachmentRepository } from '#modules/files/infrastructure/in-memory-attachment.repository.js';
import type { ProcessParticipant } from '#modules/process/domain/process-participants.js';
import { InMemoryProcessRepository } from '#modules/process/infrastructure/in-memory-process.repository.js';
import { InMemoryProcessParticipantRepository } from '#modules/process/infrastructure/process-participant.repositories.js';
import { TENANT_SETTINGS_REPOSITORY } from '#modules/tenancy/application/settings-ports.js';
import { InMemoryOrganizationRepository } from '#modules/tenancy/infrastructure/in-memory-organization.repository.js';
import type { InMemoryTenantSettingsRepository } from '#modules/tenancy/infrastructure/in-memory-tenant-settings.repository.js';
import { TIMELINE_ENTRY_STORE } from '#modules/timeline/application/ports.js';
import type { InMemoryTimelineEntryStore } from '#modules/timeline/infrastructure/in-memory-timeline-entry.store.js';
import { InMemoryWorkflowRepository } from '#modules/workflow/infrastructure/in-memory-workflow.repository.js';
import { runAsSystem } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
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

/** Repositório em memória do catálogo (specs de outros módulos não o importam — DEC-041). */
export function catalogItemRepositoryOf(api: TestApi): InMemoryCatalogItemRepository {
  return api.app.get(InMemoryCatalogItemRepository, { strict: false });
}

/** Anexos gravados no repositório em memória do `files`. */
export function attachmentsOf(api: TestApi): readonly Attachment[] {
  return [...api.app.get(InMemoryAttachmentRepository, { strict: false }).rows.values()];
}

/** Anexo AVAILABLE (PDF de 2 KiB, já verificado) no repositório em memória do `files` (US-011). */
export function seedAvailableAttachment(
  api: TestApi,
  attachment: {
    readonly tenantId: string;
    readonly processId: string;
    readonly targetType: Attachment['targetType'];
    readonly targetId: string;
    readonly uploadedById: string;
    readonly now: Date;
  },
): Attachment {
  const { tenantId, processId, now } = attachment;
  const id = newId();
  const scanning: Attachment = {
    ...createAttachment({
      id,
      tenantId,
      processId,
      targetType: attachment.targetType,
      targetId: attachment.targetId,
      categoryId: null,
      fileName: 'planilha.pdf',
      extension: 'pdf',
      declaredMimeType: 'application/pdf',
      sizeBytes: 2048,
      storageKey: `tenants/${tenantId}/processes/${processId}/attachments/${id}/planilha.pdf`,
      quarantineKey: `tenants/${tenantId}/uploads/${id}`,
      description: null,
      uploadedById: attachment.uploadedById,
      now,
    }),
    status: 'SCANNING',
  };
  const available = markAvailable(
    scanning,
    { sha256: 'b'.repeat(64), detectedMimeType: 'application/pdf', scanResult: {} },
    now,
  );
  api.app.get(InMemoryAttachmentRepository, { strict: false }).rows.set(id, available);
  return available;
}

/**
 * Anexo ainda em verificação (`SCANNING` — ClamAV fora do ar, US-068) no repositório em memória do
 * `files` (US-014: alerta `DFD_ATTACHMENTS_PENDING`).
 */
export function seedScanningAttachment(
  api: TestApi,
  attachment: Parameters<typeof seedAvailableAttachment>[1],
): Attachment {
  const available = seedAvailableAttachment(api, attachment);
  const scanning: Attachment = { ...available, status: 'SCANNING', sha256: null };
  api.app.get(InMemoryAttachmentRepository, { strict: false }).rows.set(available.id, scanning);
  return scanning;
}

/**
 * Participação ativa no processo, gravada direto no repositório em memória (US-014: consultor
 * externo `CONSULTANT` sem passar pela elegibilidade do PRC-29 — o diretório fake não tem externo
 * com vínculo vigente no tenant A).
 */
export function seedParticipant(
  api: TestApi,
  participant: Pick<ProcessParticipant, 'tenantId' | 'processId' | 'userId' | 'role'> &
    Partial<ProcessParticipant>,
): ProcessParticipant {
  const now = new Date();
  const row: ProcessParticipant = {
    id: newId(),
    departmentId: null,
    notify: false,
    grantedById: participant.userId ?? '',
    grantedAt: now,
    expiresAt: null,
    reason: null,
    revokedAt: null,
    revokedById: null,
    revocationReason: null,
    ...participant,
  };
  api.app.get(InMemoryProcessParticipantRepository, { strict: false }).put(row);
  return row;
}

export function processRepositoryOf(api: TestApi): InMemoryProcessRepository {
  return api.app.get(InMemoryProcessRepository, { strict: false });
}

/** Etapas das versões publicadas do tenant (workflow padrão do seeder — US-042). */
export function workflowStagesOf(
  api: TestApi,
  tenantId: string,
): { readonly id: string; readonly key: string; readonly workflowVersionId: string }[] {
  const repository = api.app.get(InMemoryWorkflowRepository, { strict: false });
  const published = new Set(
    [...repository.versions.values()]
      .filter((version) => version.tenantId === tenantId && version.status === 'PUBLISHED')
      .map((version) => version.id),
  );
  return [...repository.stages.values()]
    .filter((stage) => stage.tenantId === tenantId && published.has(stage.workflowVersionId))
    .map((stage) => ({ id: stage.id, key: stage.key, workflowVersionId: stage.workflowVersionId }));
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
