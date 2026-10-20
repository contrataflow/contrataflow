import type { CatalogType } from '@contrataflow/types';
import { duplicateCheckResultSchema } from '@contrataflow/validation';
import type {
  CatalogItemDto,
  CreateProcessInput,
  DepartmentDto,
  DuplicateCandidate,
  DuplicateCheckResult,
  MyPermissionsDto,
  ProcessDto,
  WorkflowResolutionDto,
} from '@contrataflow/validation';

import type { ApiError } from '@/lib/api/api-error';
import { apiRequest } from '@/lib/api/client';
import type { ApiResult } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';

import type { Lotation } from './process-form-model';

/*
 * Criação e painel do processo (US-001 · SCR-005/SCR-006): PRC-02/03/04 e WF-06 de
 * api/02-processes.md e api/10-workflow.md, mais as leituras de apoio do wizard (CAT-01, DEP-01 e
 * as lotações do ME-03). Chaves `['t', tenantId, …]` (RN-FND-90).
 */

export const processKeys = {
  all: (tenantId: string) => tenantKey(tenantId, 'processes'),
  /** SCR-006 (PRC-04): `['t', tenantId, 'processes', id, 'detail']`. */
  detail: (tenantId: string, processId: string) =>
    tenantKey(tenantId, 'processes', processId, 'detail'),
  duplicates: (tenantId: string, body: unknown) =>
    tenantKey(tenantId, 'processes', 'duplicate-check', body),
  workflow: (tenantId: string, body: unknown) => tenantKey(tenantId, 'workflows', 'resolve', body),
  /** `['t', tenantId, 'catalogs', type, …]`: só os itens ativos (CAT-01 com `isActive`). */
  activeCatalog: (tenantId: string, type: CatalogType) =>
    tenantKey(tenantId, 'catalogs', type, 'active'),
  /** `['t', tenantId, 'departments', …, orgId]`: só as unidades ativas do órgão (DEP-01). */
  activeDepartments: (tenantId: string, organizationId: string) =>
    tenantKey(tenantId, 'departments', 'active', organizationId),
};

/** Catálogos mudam pouco: 10 min (US-001 · "Frontend · Dados"). */
export const WIZARD_CATALOG_STALE_TIME_MS = 10 * 60_000;
/** Estrutura do órgão e lotações: mesma janela dos demais seletores (architecture.md §8.5). */
export const WIZARD_LOOKUP_STALE_TIME_MS = 5 * 60_000;

const PAGE_SIZE = 100;

/** CAT-01: itens ativos do catálogo, por `sortOrder`. */
export async function fetchActiveCatalog(
  type: CatalogType,
  signal?: AbortSignal,
): Promise<CatalogItemDto[]> {
  const result = await apiRequest<CatalogItemDto[]>(`/catalogs/${type}/items`, {
    query: { page: 1, pageSize: PAGE_SIZE, isActive: true },
    signal,
  });
  return result.data.filter((item) => item.isActive);
}

interface PageMeta {
  readonly totalItems?: number;
}

/** DEP-01: unidades ativas do órgão, na ordem da árvore (pais antes dos filhos). */
export async function fetchActiveDepartments(
  organizationId: string,
  signal?: AbortSignal,
): Promise<DepartmentDto[]> {
  const all: DepartmentDto[] = [];
  for (let page = 1; ; page += 1) {
    const result = await apiRequest<DepartmentDto[]>('/departments', {
      query: { organizationId, isActive: true, page, pageSize: PAGE_SIZE },
      signal,
    });
    all.push(...result.data);
    const total = (result.meta as PageMeta | undefined)?.totalItems ?? all.length;
    if (result.data.length < PAGE_SIZE || all.length >= total) {
      return all.filter((unit) => unit.isActive);
    }
  }
}

/**
 * Lotações do vínculo no tenant ativo a partir do ME-03 (`implicit.ownDepartmentIds`, base do
 * escopo `OWN_DEPARTMENTS`). `null` = permissões ainda não carregadas. O ME-03 não diz qual é a
 * principal: o wizard só pré-preenche sozinho quando há uma única lotação elegível.
 */
export function lotationsOf(permissions: MyPermissionsDto | undefined): Lotation[] | null {
  if (permissions === undefined) return null;
  return permissions.implicit.ownDepartmentIds.map((id) => ({ id, isPrimary: false }));
}

/** SET-03: `process.requireInternalCode` (FA-09). */
export function readRequireInternalCode(
  publicSettings: Readonly<Record<string, unknown>> | undefined,
) {
  return publicSettings?.['process.requireInternalCode'] === true;
}

/** SET-03: `numbering.process.scope = ORGANIZATION` (FA-04), quando a API o expõe. */
export function readNumberingByOrganization(
  publicSettings: Readonly<Record<string, unknown>> | undefined,
) {
  return publicSettings?.['numbering.process.scope'] === 'ORGANIZATION';
}

/** PRC-03. */
export async function checkDuplicates(
  body: { title: string; object: string; requestingDepartmentId: string },
  signal?: AbortSignal,
): Promise<DuplicateCandidate[]> {
  const result = await apiRequest<DuplicateCheckResult>('/processes/check-duplicates', {
    method: 'POST',
    body,
    signal,
  });
  return Array.isArray(result.data.candidates) ? result.data.candidates : [];
}

/** WF-06. */
export async function resolveWorkflow(
  body: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<WorkflowResolutionDto> {
  return (
    await apiRequest<WorkflowResolutionDto>('/workflows/resolve', {
      method: 'POST',
      body,
      signal,
    })
  ).data;
}

/** PRC-02; a mesma `Idempotency-Key` vale para cada reenvio dentro da sessão do wizard. */
export function createProcess(
  body: CreateProcessInput,
  idempotencyKey: string,
  correlationId?: string,
): Promise<ApiResult<ProcessDto>> {
  return apiRequest<ProcessDto>('/processes', {
    method: 'POST',
    body,
    idempotencyKey,
    ...(correlationId ? { correlationId } : {}),
  });
}

/** PRC-04. */
export async function fetchProcess(processId: string, signal?: AbortSignal): Promise<ProcessDto> {
  return (await apiRequest<ProcessDto>(`/processes/${processId}`, { signal })).data;
}

/** Candidatos do 409 `POSSIBLE_DUPLICATE_PROCESS` (membro de extensão `candidates`). */
export function duplicateCandidatesOf(error: ApiError): DuplicateCandidate[] {
  const parsed = duplicateCheckResultSchema.safeParse({ candidates: error.problem?.candidates });
  return parsed.success ? parsed.data.candidates : [];
}
