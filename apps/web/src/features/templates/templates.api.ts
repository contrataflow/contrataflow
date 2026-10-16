import type {
  DocumentTypeDto,
  TemplateCreate,
  TemplateDto,
  TemplateUpdate,
  TemplateVersionDto,
  TemplateVersionHistoryItem,
  TemplateVersionUpdateInput,
} from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';
import type { ApiResult } from '@/lib/api/client';
import type { IdempotentContext } from '@/lib/api/use-idempotent-mutation';
import { tenantKey } from '@/lib/query/keys';

/*
 * Templates (US-107/US-108 · SCR-033/SCR-114): TPL-01..08/10/11 de api/04-templates.md e o DTY-04
 * (template padrão do tipo). As chaves seguem a convenção `['t', tenantId, …]` (RN-FND-90).
 */

export const TEMPLATES_PATH = '/admin/templates';

export function templateEditorHref(templateId: string, versionId: string): string {
  return `${TEMPLATES_PATH}/${templateId}/versoes/${versionId}`;
}

/** SCR-033, aba "Versões" (US-108). */
export function templateVersionsHref(templateId: string): string {
  return `${TEMPLATES_PATH}/${templateId}`;
}

export const templateKeys = {
  all: (tenantId: string) => tenantKey(tenantId, 'templates'),
  list: (tenantId: string) => tenantKey(tenantId, 'templates', 'list'),
  detail: (tenantId: string, templateId: string) =>
    tenantKey(tenantId, 'templates', 'detail', templateId),
  versions: (tenantId: string, templateId: string) =>
    tenantKey(tenantId, 'templates', 'versions', templateId),
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

/** TPL-03. */
export function fetchTemplate(id: string, signal?: AbortSignal): Promise<ApiResult<TemplateDto>> {
  return apiRequest<TemplateDto>(`/templates/${id}`, { signal });
}

/** TPL-05: histórico de versões (até 100, da mais recente para a mais antiga). */
export function fetchTemplateVersions(
  templateId: string,
  signal?: AbortSignal,
): Promise<ApiResult<TemplateVersionHistoryItem[]>> {
  return apiRequest<TemplateVersionHistoryItem[]>(`/templates/${templateId}/versions`, {
    query: { pageSize: 100 },
    signal,
  });
}

/** TPL-06: novo rascunho a partir da versão mais recente (`Idempotency-Key` da intenção). */
export function createTemplateVersion(
  templateId: string,
  context: IdempotentContext,
): Promise<ApiResult<TemplateVersionDto>> {
  return apiRequest<TemplateVersionDto>(`/templates/${templateId}/versions`, {
    method: 'POST',
    idempotencyKey: context.idempotencyKey,
    correlationId: context.correlationId,
  });
}

/** TPL-10: publicar o rascunho com a revisão lida em `If-Match` (`Idempotency-Key` da intenção). */
export function publishTemplateVersion(
  versionId: string,
  version: number,
  context: IdempotentContext,
): Promise<ApiResult<TemplateVersionDto>> {
  return apiRequest<TemplateVersionDto>(`/template-versions/${versionId}/publish`, {
    method: 'POST',
    ifMatch: `"${version}"`,
    idempotencyKey: context.idempotencyKey,
    correlationId: context.correlationId,
  });
}

/** TPL-11: aposentar a versão publicada com a revisão lida em `If-Match`. */
export function retireTemplateVersion(
  versionId: string,
  version: number,
): Promise<ApiResult<TemplateVersionDto>> {
  return apiRequest<TemplateVersionDto>(`/template-versions/${versionId}/retire`, {
    method: 'POST',
    ifMatch: `"${version}"`,
  });
}

/** DTY-04: template padrão do tipo, com a versão do tipo em `If-Match`. */
export function setDefaultTemplate(
  documentTypeId: string,
  templateId: string,
  version: number,
): Promise<ApiResult<DocumentTypeDto>> {
  return apiRequest<DocumentTypeDto>(`/document-types/${documentTypeId}/default-template`, {
    method: 'PUT',
    body: { templateId },
    ifMatch: `"${version}"`,
  });
}

/** `contentHash` resumido para exibição (os 12 primeiros caracteres). */
export function shortHash(hash: string | null): string | null {
  return hash ? hash.slice(0, 12) : null;
}
