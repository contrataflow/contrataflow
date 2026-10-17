import { riskListMetaSchema } from '@contrataflow/validation';
import type {
  CreateRiskInput,
  RiskDto,
  RiskListMetaDto,
  RiskPhase,
  RiskStatus,
  UpdateRiskInput,
} from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';

import { apiRequest } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

import {
  WIZARD_CATALOG_STALE_TIME_MS,
  fetchActiveCatalog,
  processKeys,
} from '../processes/processes.api';

/*
 * Riscos do processo (US-033 · SCR-011): RSK-01/02/04/05 de api/08-risks.md. Chave
 * `['t', tenantId, 'processes', id, 'risks']` (sob a do processo: a invalidação do painel a
 * alcança). RSK-01 devolve a escala vigente, o `RISK_MAP` e se o usuário pode gerenciar em `meta`.
 * PATCH e DELETE usam a versão do risco (`version` do DTO) como `If-Match`.
 */

export const riskKeys = {
  list: (tenantId: string, processId: string) =>
    tenantKey(tenantId, 'processes', processId, 'risks'),
};

export interface RiskList {
  readonly risks: readonly RiskDto[];
  readonly meta: RiskListMetaDto;
}

export interface RiskFilters {
  readonly phase?: RiskPhase | undefined;
  readonly categoryId?: string | undefined;
  readonly status?: RiskStatus | undefined;
}

const ifMatch = (version: number) => `"${String(version)}"`;

/** RSK-01. Resposta sem o `meta` esperado vira erro (a tela mostra "Tentar novamente"). */
export async function fetchRisks(
  processId: string,
  filters: RiskFilters = {},
  signal?: AbortSignal,
): Promise<RiskList> {
  const result = await apiRequest<RiskDto[]>(`/processes/${processId}/risks`, {
    query: { phase: filters.phase, categoryId: filters.categoryId, status: filters.status },
    signal,
  });
  const meta = riskListMetaSchema.safeParse(result.meta);
  if (!meta.success) throw new Error('Resposta de riscos sem a escala vigente.');
  return { risks: Array.isArray(result.data) ? result.data : [], meta: meta.data };
}

export function useRisks(processId: string) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: riskKeys.list(tenantId, processId),
    queryFn: ({ signal }) => fetchRisks(processId, {}, signal),
    refetchOnWindowFocus: true,
    throwOnError: false,
  });
}

/** CAT-01: categorias de risco ativas (o select só lista itens ativos). */
export function useRiskCategories() {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: processKeys.activeCatalog(tenantId, 'RISK_CATEGORY'),
    queryFn: ({ signal }) => fetchActiveCatalog('RISK_CATEGORY', signal),
    staleTime: WIZARD_CATALOG_STALE_TIME_MS,
    throwOnError: false,
  });
}

/** RSK-02 (a mesma `Idempotency-Key` em cada reenvio do mesmo formulário). */
export async function createRisk(
  processId: string,
  body: CreateRiskInput,
  idempotencyKey: string,
): Promise<RiskDto> {
  return (
    await apiRequest<RiskDto>(`/processes/${processId}/risks`, {
      method: 'POST',
      body,
      idempotencyKey,
    })
  ).data;
}

/** RSK-04 com a versão do risco. */
export async function updateRisk(
  riskId: string,
  body: UpdateRiskInput,
  version: number,
): Promise<RiskDto> {
  return (
    await apiRequest<RiskDto>(`/risks/${riskId}`, {
      method: 'PATCH',
      body,
      ifMatch: ifMatch(version),
    })
  ).data;
}

/** RSK-05 com a versão do risco (exclui também os tratamentos vinculados — RN-RISK-10). */
export async function deleteRisk(riskId: string, version: number): Promise<void> {
  await apiRequest<unknown>(`/risks/${riskId}`, {
    method: 'DELETE',
    ifMatch: ifMatch(version),
  });
}
