import { etpDetailMetaSchema } from '@contrataflow/validation';
import type {
  EtpCreate,
  EtpDetailDto,
  EtpDetailMeta,
  EtpDto,
  EtpSummaryDto,
  ImportableDfdDto,
} from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';

import { isApiError } from '@/lib/api/api-error';
import { apiRequest } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

/*
 * ETP (US-019/020 · SCR-006/SCR-008): ETP-01/02/03 de api/06-etp.md. O id do ETP é o do documento.
 * Chaves `['t', tenantId, 'processes', processId, 'etps']` (ETP-01, sob a do processo: invalidar o
 * processo renova a lista e o DFD elegível) e `['t', tenantId, 'etps', id]` (ETP-03).
 */

export const etpKeys = {
  ofProcess: (tenantId: string, processId: string) =>
    tenantKey(tenantId, 'processes', processId, 'etps'),
  detail: (tenantId: string, etpId: string) => tenantKey(tenantId, 'etps', etpId),
};

/** ETP-03: o ETP com o rascunho por seção e `meta` (ações + seções do template). */
export interface EtpResult {
  readonly etp: EtpDetailDto;
  readonly meta: EtpDetailMeta;
}

export async function fetchEtp(etpId: string, signal?: AbortSignal): Promise<EtpResult> {
  const result = await apiRequest<EtpDetailDto>(`/etps/${etpId}`, { signal });
  const meta = etpDetailMetaSchema.safeParse(result.meta);
  return {
    etp: result.data,
    meta: meta.success ? meta.data : { allowedActions: [], template: null },
  };
}

export function useEtp(etpId: string) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: etpKeys.detail(tenantId, etpId),
    queryFn: ({ signal }) => fetchEtp(etpId, signal),
    throwOnError: false,
  });
}

/** ETP-01: os ETPs do processo e o DFD elegível para a importação (RN-ETP-04). */
export interface ProcessEtps {
  readonly items: readonly EtpSummaryDto[];
  readonly importableDfd: ImportableDfdDto | null;
}

/** Rota da SCR-008. */
export function etpHref(processId: string, etpId: string): string {
  return `/processos/${processId}/etp/${etpId}`;
}

export async function fetchProcessEtps(
  processId: string,
  signal?: AbortSignal,
): Promise<ProcessEtps> {
  const result = await apiRequest<EtpSummaryDto[]>(`/processes/${processId}/etps`, { signal });
  const importable = (result.meta as { importableDfd?: ImportableDfdDto | null }).importableDfd;
  return {
    items: Array.isArray(result.data) ? result.data : [],
    importableDfd: importable ?? null,
  };
}

/** O ETP não cancelado do processo (FA-03), se houver. */
export function activeEtpOf(etps: ProcessEtps | undefined): EtpSummaryDto | null {
  return etps?.items.find((etp) => etp.status !== 'CANCELED') ?? null;
}

export function useProcessEtps(processId: string, enabled = true) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: etpKeys.ofProcess(tenantId, processId),
    queryFn: ({ signal }) => fetchProcessEtps(processId, signal),
    enabled,
    throwOnError: false,
  });
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * ETP-02 (a mesma `Idempotency-Key` em cada reenvio da mesma solicitação — FA-04).
 * `IDEMPOTENCY_IN_PROGRESS` (a mesma solicitação ainda em processamento) repete após 2 s, até 3 vezes.
 */
export async function createEtp(
  processId: string,
  body: EtpCreate,
  idempotencyKey: string,
): Promise<EtpDto> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await apiRequest<EtpDto>(`/processes/${processId}/etps`, {
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
