import { termDetailMetaSchema, termListMetaSchema } from '@contrataflow/validation';
import type {
  TermCreate,
  TermDetailDto,
  TermDetailMeta,
  TermDto,
  TermListMeta,
  TermMeta,
  TermPatch,
  TermSummaryDto,
} from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';

import { isApiError } from '@/lib/api/api-error';
import { apiRequest } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

/*
 * Termo de Referência (US-036 · SCR-006/SCR-012): TRM-01..04 de api/09-term-of-reference.md. O id do
 * TR é o do documento. Chaves `['t', tenantId, 'processes', processId, 'terms']` (TRM-01, sob a do
 * processo: invalidar o processo renova a lista) e `['t', tenantId, 'terms', termId]` (TRM-03).
 */

export const termKeys = {
  ofProcess: (tenantId: string, processId: string) =>
    tenantKey(tenantId, 'processes', processId, 'terms'),
  detail: (tenantId: string, termId: string) => tenantKey(tenantId, 'terms', termId),
};

/** Rota da SCR-012. */
export function termHref(processId: string, termId: string): string {
  return `/processos/${processId}/tr/${termId}`;
}

/** TRM-03: o TR com o rascunho por seção e `meta` (ações + seções do template). */
export interface TermResult {
  readonly term: TermDetailDto;
  readonly meta: TermDetailMeta;
}

export async function fetchTerm(termId: string, signal?: AbortSignal): Promise<TermResult> {
  const result = await apiRequest<TermDetailDto>(`/terms/${termId}`, { signal });
  const meta = termDetailMetaSchema.safeParse(result.meta);
  return {
    term: result.data,
    meta: meta.success ? meta.data : { allowedActions: [], template: null },
  };
}

export function useTerm(termId: string) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: termKeys.detail(tenantId, termId),
    queryFn: ({ signal }) => fetchTerm(termId, signal),
    throwOnError: false,
  });
}

/** TRM-01: os TRs do processo, os modelos publicados e o título padrão do diálogo. */
export interface ProcessTerms {
  readonly items: readonly TermSummaryDto[];
  readonly meta: TermListMeta;
}

export async function fetchProcessTerms(
  processId: string,
  signal?: AbortSignal,
): Promise<ProcessTerms> {
  const result = await apiRequest<TermSummaryDto[]>(`/processes/${processId}/terms`, { signal });
  const meta = termListMetaSchema.safeParse(result.meta);
  return {
    items: Array.isArray(result.data) ? result.data : [],
    meta: meta.success ? meta.data : { templates: [], defaultTitle: '' },
  };
}

/** O TR não cancelado do processo (FA-02), se houver. */
export function activeTermOf(terms: ProcessTerms | undefined): TermSummaryDto | null {
  return terms?.items.find((term) => term.status !== 'CANCELED') ?? null;
}

export function useProcessTerms(processId: string, enabled = true) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: termKeys.ofProcess(tenantId, processId),
    queryFn: ({ signal }) => fetchProcessTerms(processId, signal),
    enabled,
    throwOnError: false,
  });
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * TRM-02 (a mesma `Idempotency-Key` em cada reenvio da mesma solicitação).
 * `IDEMPOTENCY_IN_PROGRESS` (a mesma solicitação ainda em processamento) repete após 2 s, até 3 vezes.
 */
export async function createTerm(
  processId: string,
  body: TermCreate,
  idempotencyKey: string,
): Promise<TermDto> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await apiRequest<TermDto>(`/processes/${processId}/terms`, {
        method: 'POST',
        body,
        idempotencyKey,
      });
      return result.data;
    } catch (error) {
      if (attempt >= 3 || !isApiError(error) || error.code !== 'IDEMPOTENCY_IN_PROGRESS') {
        throw error;
      }
      await sleep((error.retryAfterSeconds ?? 2) * 1000);
    }
  }
}

/** TRM-04: o TR depois do PATCH e as ações permitidas. */
export interface TermPatched {
  readonly term: TermDto;
  readonly meta: TermMeta | null;
}

/** TRM-04: `If-Match: "<version>"` do TR (objeto e valor estimado). */
export async function patchTerm(
  termId: string,
  body: TermPatch,
  version: number,
): Promise<TermPatched> {
  const result = await apiRequest<TermDto>(`/terms/${termId}`, {
    method: 'PATCH',
    body,
    ifMatch: `"${String(version)}"`,
  });
  const allowed = (result.meta as { allowedActions?: unknown }).allowedActions;
  return {
    term: result.data,
    meta: Array.isArray(allowed) ? { allowedActions: allowed as TermMeta['allowedActions'] } : null,
  };
}
