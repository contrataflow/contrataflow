import type { InternalEchoRequest } from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';
import type { ApiResult } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';

/*
 * Feature de exemplo do shell (US-086): consome as rotas internas da US-080 (`/_internal/*`),
 * fora do contrato público. Nenhuma regra de negócio — só demonstra as convenções.
 */

export interface InternalPing {
  readonly status: 'ok';
  readonly correlationId: string;
  readonly tenantId: string | null;
  readonly userId: string | null;
  readonly membershipId: string | null;
}

export interface InternalItem {
  readonly id: string;
  readonly position: number;
}

export interface InternalEcho {
  readonly id: string;
  readonly name: string;
  readonly quantity: number | null;
}

export const EXAMPLE_PAGE_SIZE = 10;

export const exampleKeys = {
  all: (tenantId: string) => tenantKey(tenantId, 'example'),
  ping: (tenantId: string) => [...exampleKeys.all(tenantId), 'ping'] as const,
  items: (tenantId: string, page: number) =>
    [...exampleKeys.all(tenantId), 'items', { page }] as const,
};

export const examplePaths = {
  ping: '/_internal/ping',
  items: '/_internal/items',
  echo: '/_internal/echo',
} as const;

export function itemsQuery(page: number) {
  return { page, pageSize: EXAMPLE_PAGE_SIZE };
}

export function fetchPing(signal?: AbortSignal): Promise<ApiResult<InternalPing>> {
  return apiRequest<InternalPing>(examplePaths.ping, { signal });
}

export function fetchItems(page: number, signal?: AbortSignal): Promise<ApiResult<InternalItem[]>> {
  return apiRequest<InternalItem[]>(examplePaths.items, { query: itemsQuery(page), signal });
}

export function createEcho(
  body: InternalEchoRequest,
  action: { readonly idempotencyKey: string; readonly correlationId?: string },
): Promise<ApiResult<InternalEcho>> {
  return apiRequest<InternalEcho>(examplePaths.echo, {
    method: 'POST',
    body,
    idempotencyKey: action.idempotencyKey,
    correlationId: action.correlationId,
  });
}
