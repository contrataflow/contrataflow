import type {
  CreateTagInput,
  ProcessTagsDto,
  TagDto,
  UpdateTagInput,
} from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';

import { isApiError } from '@/lib/api/api-error';
import { apiRequest } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

/*
 * Etiquetas (US-007): TAG-01..03 e PRC-18 de api/02-processes.md. Chaves `['t', tenantId, 'tags', …]`
 * (RN-FND-90). A lista é lida com frequência (lista de processos e seletor): `staleTime` de 10 min,
 * invalidada depois de TAG-02/TAG-03.
 */

export const tagKeys = {
  all: (tenantId: string) => tenantKey(tenantId, 'tags'),
  list: (tenantId: string, includeInactive: boolean) =>
    tenantKey(tenantId, 'tags', includeInactive ? 'with-inactive' : 'active'),
};

export const TAGS_STALE_TIME_MS = 10 * 60_000;

/** TAG-01: `includeInactive` só é atendido pela API para quem tem `TAG_MANAGE` (RN-PROC-91). */
export async function fetchTags(includeInactive: boolean, signal?: AbortSignal): Promise<TagDto[]> {
  const result = await apiRequest<TagDto[]>('/tags', {
    query: includeInactive ? { includeInactive: true } : undefined,
    signal,
  });
  return Array.isArray(result.data) ? result.data : [];
}

export function useTags(includeInactive: boolean, enabled = true) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: tagKeys.list(tenantId, includeInactive),
    queryFn: ({ signal }) => fetchTags(includeInactive, signal),
    staleTime: TAGS_STALE_TIME_MS,
    enabled,
    // O erro fica no bloco (com "Tentar novamente"): nunca derruba a tela.
    throwOnError: false,
  });
}

/** TAG-02 (`Idempotency-Key` por intenção do usuário). */
export async function createTag(
  body: CreateTagInput,
  context: { readonly idempotencyKey: string; readonly correlationId: string },
): Promise<TagDto> {
  return (
    await apiRequest<TagDto>('/tags', {
      method: 'POST',
      body,
      idempotencyKey: context.idempotencyKey,
      correlationId: context.correlationId,
    })
  ).data;
}

/** TAG-03: só os campos alterados, com a versão da etiqueta em `If-Match`. */
export async function updateTag(
  id: string,
  patch: UpdateTagInput,
  version: number,
): Promise<TagDto> {
  return (
    await apiRequest<TagDto>(`/tags/${id}`, {
      method: 'PATCH',
      body: patch,
      ifMatch: `"${String(version)}"`,
    })
  ).data;
}

/** PRC-18: o conjunto completo final, com a versão do PROCESSO em `If-Match`. */
export async function setProcessTags(
  processId: string,
  tagIds: readonly string[],
  version: number,
): Promise<ProcessTagsDto> {
  return (
    await apiRequest<ProcessTagsDto>(`/processes/${processId}/tags`, {
      method: 'PUT',
      body: { tagIds },
      ifMatch: `"${String(version)}"`,
    })
  ).data;
}

export type ProcessTagsErrorKey =
  | 'conflict'
  | 'validation'
  | 'permission'
  | 'status'
  | 'notFound'
  | 'rateLimited'
  | 'unavailable'
  | 'unexpected';

/** Mensagem de erro do PRC-18 ("Casos de erro" da story); 401 fica com o cliente. */
export function processTagsErrorOf(error: unknown): {
  readonly key: ProcessTagsErrorKey;
  readonly correlationId: string;
  /** O processo pode ter mudado: recarregar o painel. */
  readonly reload: boolean;
} {
  const correlationId = isApiError(error) ? (error.correlationId ?? '—') : '—';
  if (!isApiError(error)) return { key: 'unexpected', correlationId, reload: false };
  switch (error.status) {
    case 412:
    case 428:
      return { key: 'conflict', correlationId, reload: true };
    case 422:
      return { key: 'validation', correlationId, reload: false };
    case 403:
      return { key: 'permission', correlationId, reload: true };
    case 409:
      return { key: 'status', correlationId, reload: true };
    case 404:
      return { key: 'notFound', correlationId, reload: true };
    case 429:
      return { key: 'rateLimited', correlationId, reload: false };
    case 503:
      return { key: 'unavailable', correlationId, reload: false };
    default:
      return { key: 'unexpected', correlationId, reload: false };
  }
}
