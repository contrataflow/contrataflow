import type { EtpCreate, EtpDto, EtpSummaryDto, ImportableDfdDto } from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';

import { isApiError } from '@/lib/api/api-error';
import { apiRequest } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

/*
 * ETP (US-019 · SCR-006/SCR-008): ETP-01/02 de api/06-etp.md. O id do ETP é o do documento. Chave
 * `['t', tenantId, 'processes', processId, 'etps']` (ETP-01, sob a do processo: invalidar o
 * processo renova a lista e o DFD elegível).
 */

export const etpKeys = {
  ofProcess: (tenantId: string, processId: string) =>
    tenantKey(tenantId, 'processes', processId, 'etps'),
};

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
