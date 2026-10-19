import { etpAlternativeListMetaSchema } from '@contrataflow/validation';
import type {
  CreateEtpAlternative,
  DecideEtpAlternative,
  EtpAlternativeDto,
  EtpAlternativeListMeta,
  UpdateEtpAlternative,
} from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';

import { apiRequest } from '@/lib/api/client';
import { useTenantId } from '@/lib/session/session-context';

import { etpKeys } from './etp.api';

/*
 * Alternativas de solução do ETP (US-021 · SCR-008, seção "Alternativas"): ETP-05..09 de
 * api/06-etp.md. Chave `['t', tenantId, 'etps', etpId, 'alternatives']` (sob a do ETP: invalidar o
 * ETP renova o quadro e a `recommendedAlternativeId` do cabeçalho). PATCH, DELETE e decide usam a
 * `version` da alternativa como `If-Match`.
 */

export const etpAlternativeKeys = {
  list: (tenantId: string, etpId: string) => [...etpKeys.detail(tenantId, etpId), 'alternatives'],
};

const ifMatch = (version: number) => `"${String(version)}"`;

export interface EtpAlternativeList {
  readonly alternatives: readonly EtpAlternativeDto[];
  readonly meta: EtpAlternativeListMeta;
}

/** ETP-05: as alternativas por `sortOrder` e se a pessoa pode alterá-las (`meta.canManage`). */
export async function fetchEtpAlternatives(
  etpId: string,
  signal?: AbortSignal,
): Promise<EtpAlternativeList> {
  const result = await apiRequest<EtpAlternativeDto[]>(`/etps/${etpId}/alternatives`, { signal });
  const meta = etpAlternativeListMetaSchema.safeParse(result.meta);
  return {
    alternatives: Array.isArray(result.data) ? result.data : [],
    meta: meta.success
      ? meta.data
      : { canManage: false, recommendedAlternativeId: null, estimatedCostMasked: true },
  };
}

export function useEtpAlternatives(etpId: string) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: etpAlternativeKeys.list(tenantId, etpId),
    queryFn: ({ signal }) => fetchEtpAlternatives(etpId, signal),
    throwOnError: false,
  });
}

/** ETP-06. */
export async function createEtpAlternative(
  etpId: string,
  body: CreateEtpAlternative,
): Promise<EtpAlternativeDto> {
  return (
    await apiRequest<EtpAlternativeDto>(`/etps/${etpId}/alternatives`, { method: 'POST', body })
  ).data;
}

/** ETP-07 com a versão da alternativa (campos ou `sortOrder`). */
export async function updateEtpAlternative(
  alternativeId: string,
  body: UpdateEtpAlternative,
  version: number,
): Promise<EtpAlternativeDto> {
  return (
    await apiRequest<EtpAlternativeDto>(`/etp-alternatives/${alternativeId}`, {
      method: 'PATCH',
      body,
      ifMatch: ifMatch(version),
    })
  ).data;
}

/** ETP-08 com a versão da alternativa (exclusão lógica). */
export async function deleteEtpAlternative(alternativeId: string, version: number): Promise<void> {
  await apiRequest<unknown>(`/etp-alternatives/${alternativeId}`, {
    method: 'DELETE',
    ifMatch: ifMatch(version),
  });
}

/** ETP-09 com a versão da alternativa. */
export async function decideEtpAlternative(
  alternativeId: string,
  body: DecideEtpAlternative,
  version: number,
): Promise<EtpAlternativeDto> {
  return (
    await apiRequest<EtpAlternativeDto>(`/etp-alternatives/${alternativeId}/decide`, {
      method: 'POST',
      body,
      ifMatch: ifMatch(version),
    })
  ).data;
}
