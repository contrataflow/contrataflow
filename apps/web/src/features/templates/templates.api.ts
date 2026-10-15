import type {
  DocumentTypeDto,
  TemplateCreate,
  TemplateDto,
  TemplateUpdate,
  TemplateVersionDto,
  TemplateVersionUpdateInput,
} from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';
import type { ApiResult } from '@/lib/api/client';
import type { IdempotentContext } from '@/lib/api/use-idempotent-mutation';
import { tenantKey } from '@/lib/query/keys';

/*
 * Templates (US-107 · SCR-033/SCR-114): TPL-01..04/07/08 de api/04-templates.md. As chaves seguem a
 * convenção `['t', tenantId, …]` (RN-FND-90).
 */

export const TEMPLATES_PATH = '/admin/templates';

export function templateEditorHref(templateId: string, versionId: string): string {
  return `${TEMPLATES_PATH}/${templateId}/versoes/${versionId}`;
}

export const templateKeys = {
  all: (tenantId: string) => tenantKey(tenantId, 'templates'),
  list: (tenantId: string) => tenantKey(tenantId, 'templates', 'list'),
  version: (tenantId: string, versionId: string) =>
    tenantKey(tenantId, 'templates', 'version', versionId),
};

/** Staleness das telas de configuração (architecture.md §8.5). */
export const TEMPLATES_STALE_TIME_MS = 60_000;

/** TPL-01: a administração lê todos os templates do tenant (até 100 por página). */
export function fetchTemplates(signal?: AbortSignal): Promise<ApiResult<TemplateDto[]>> {
  return apiRequest<TemplateDto[]>('/templates', { query: { pageSize: 100 }, signal });
}

/** TPL-02: `Idempotency-Key` da intenção do usuário. */
export function createTemplate(
  body: TemplateCreate,
  context: IdempotentContext,
): Promise<ApiResult<TemplateDto>> {
  return apiRequest<TemplateDto>('/templates', {
    method: 'POST',
    body,
    idempotencyKey: context.idempotencyKey,
    correlationId: context.correlationId,
  });
}

/** TPL-04: só os campos alterados, com a versão lida em `If-Match`. */
export function updateTemplate(
  id: string,
  patch: TemplateUpdate,
  version: number,
): Promise<ApiResult<TemplateDto>> {
  return apiRequest<TemplateDto>(`/templates/${id}`, {
    method: 'PATCH',
    body: patch,
    ifMatch: `"${version}"`,
  });
}

/** TPL-07. */
export function fetchTemplateVersion(
  versionId: string,
  signal?: AbortSignal,
): Promise<ApiResult<TemplateVersionDto>> {
  return apiRequest<TemplateVersionDto>(`/template-versions/${versionId}`, { signal });
}

/** TPL-08: autosave do rascunho com a revisão atual em `If-Match`. */
export function updateTemplateVersion(
  versionId: string,
  patch: TemplateVersionUpdateInput,
  version: number,
): Promise<ApiResult<TemplateVersionDto>> {
  return apiRequest<TemplateVersionDto>(`/template-versions/${versionId}`, {
    method: 'PATCH',
    body: patch,
    ifMatch: `"${version}"`,
  });
}

/** DTY-01 sem `includeInactive`: os tipos ativos que podem receber template (RN-DOC-12). */
export function fetchActiveDocumentTypes(
  signal?: AbortSignal,
): Promise<ApiResult<DocumentTypeDto[]>> {
  return apiRequest<DocumentTypeDto[]>('/document-types', { signal });
}

export const activeDocumentTypesKey = (tenantId: string) =>
  tenantKey(tenantId, 'document-types', { includeInactive: false });
