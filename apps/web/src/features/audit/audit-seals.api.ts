import type {
  AuditSealDto,
  AuditSealVerification,
  VerifyAuditSeals,
} from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';

/*
 * Selos de integridade da trilha de auditoria (US-074 · SCR-037, aba "Selos"): AUD-04 (listar,
 * paginado por página) e AUD-05 (verificar um intervalo — somente cálculo, nada é gravado).
 * Chaves `['t', tenantId, 'audit', 'seals', …]` (RN-FND-90).
 */

export const auditKeys = {
  all: (tenantId: string) => tenantKey(tenantId, 'audit'),
  seals: (tenantId: string) => tenantKey(tenantId, 'audit', 'seals'),
  sealList: (tenantId: string, filters: SealListFilters) =>
    tenantKey(tenantId, 'audit', 'seals', filters),
};

/** Selos novos surgem a cada hora: janela curta, sem sondagem. */
export const AUDIT_SEALS_STALE_TIME_MS = 30_000;

export const SEAL_PAGE_SIZE = 20;

export interface SealListFilters {
  readonly page: number;
  readonly pageSize: number;
}

export interface SealPage {
  readonly items: readonly AuditSealDto[];
  readonly page: number;
  readonly totalItems: number;
  readonly totalPages: number;
}

/** AUD-04 (`AUDIT_VIEW`). */
export async function fetchAuditSeals(
  filters: SealListFilters,
  signal?: AbortSignal,
): Promise<SealPage> {
  const result = await apiRequest<AuditSealDto[]>('/audit/seals', {
    query: { page: filters.page, pageSize: filters.pageSize },
    signal,
  });
  const meta = result.meta as unknown as {
    page?: number;
    totalItems?: number;
    totalPages?: number;
  };
  const items = Array.isArray(result.data) ? result.data : [];
  return {
    items,
    page: meta.page ?? filters.page,
    totalItems: meta.totalItems ?? items.length,
    totalPages: Math.max(1, meta.totalPages ?? 1),
  };
}

/** AUD-05 (`AUDIT_VIEW` + MFA, POL-14): recalcula `digest` e `chainHash` dos selos do intervalo. */
export async function verifyAuditSeals(body: VerifyAuditSeals): Promise<AuditSealVerification> {
  return (await apiRequest<AuditSealVerification>('/audit/seals/verify', { method: 'POST', body }))
    .data;
}
