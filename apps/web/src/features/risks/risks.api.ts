import { riskListMetaSchema, riskMatrixSchema } from '@contrataflow/validation';
import type {
  ApplyAiRisksInput,
  ApplyAiRisksResultDto,
  CreateRiskInput,
  CreateRiskTreatmentInput,
  DocumentDto,
  RiskDto,
  RiskListMetaDto,
  RiskMatrixDto,
  RiskPhase,
  RiskStatus,
  ReviewAiRisksResultDto,
  RiskTreatmentDto,
  UpdateRiskInput,
  UpdateRiskTreatmentInput,
} from '@contrataflow/validation';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { apiRequest } from '@/lib/api/client';
import type { IdempotentContext } from '@/lib/api/use-idempotent-mutation';
import { tenantKey } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

import {
  WIZARD_CATALOG_STALE_TIME_MS,
  fetchActiveCatalog,
  processKeys,
} from '../processes/processes.api';

/*
 * Riscos do processo (US-033 · SCR-011): RSK-01/02/04/05 de api/08-risks.md, e as ações de
 * tratamento (US-034): RSK-06..08 (lidas pelos riscos — `Risk.treatments`). Chave
 * `['t', tenantId, 'processes', id, 'risks']` (sob a do processo: a invalidação do painel a
 * alcança). RSK-01 devolve a escala vigente, o `RISK_MAP` e se o usuário pode gerenciar em `meta`.
 * PATCH e DELETE usam a versão do risco/tratamento (`version` do DTO) como `If-Match`. A matriz
 * (US-035 · RSK-09) fica sob a chave da lista: toda invalidação dos riscos a recalcula; o Mapa de
 * Riscos (RSK-10) é um documento — o resto do ciclo de vida é o da tela de documento (US-065).
 */

export const riskKeys = {
  list: (tenantId: string, processId: string) =>
    tenantKey(tenantId, 'processes', processId, 'risks'),
  matrix: (tenantId: string, processId: string, filters: RiskFilters) =>
    tenantKey(tenantId, 'processes', processId, 'risks', 'matrix', {
      phase: filters.phase ?? null,
      categoryId: filters.categoryId ?? null,
      status: filters.status ?? null,
    }),
  /** DOC-08 do Mapa de Riscos lido pela aba "Matriz": recalculado a cada mudança nos riscos. */
  mapValidation: (tenantId: string, processId: string, documentId: string) =>
    tenantKey(tenantId, 'processes', processId, 'risks', 'map-validation', documentId),
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

/** RSK-09 — matriz da escala vigente com os filtros (não persistidos). */
export async function fetchRiskMatrix(
  processId: string,
  filters: RiskFilters = {},
  signal?: AbortSignal,
): Promise<RiskMatrixDto> {
  const result = await apiRequest<RiskMatrixDto>(`/processes/${processId}/risk-matrix`, {
    query: { phase: filters.phase, categoryId: filters.categoryId, status: filters.status },
    signal,
  });
  return riskMatrixSchema.parse(result.data);
}

/** A matriz filtrada; ao trocar o filtro, a grade anterior fica na tela até a nova chegar. */
export function useRiskMatrix(processId: string, filters: RiskFilters) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: riskKeys.matrix(tenantId, processId, filters),
    queryFn: ({ signal }) => fetchRiskMatrix(processId, filters, signal),
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: true,
    throwOnError: false,
  });
}

/** RSK-10 — emitir o Mapa de Riscos (a mesma `Idempotency-Key` em cada reenvio da intenção). */
export async function createRiskMap(
  processId: string,
  idempotencyKey: string,
): Promise<DocumentDto> {
  return (
    await apiRequest<DocumentDto>(`/processes/${processId}/risk-map`, {
      method: 'POST',
      body: {},
      idempotencyKey,
    })
  ).data;
}

/** Tela de documento (US-062/US-065) — onde o Mapa de Riscos é conferido, finalizado e reaberto. */
export function riskMapHref(processId: string, documentId: string): string {
  return `/processos/${processId}/documentos/${documentId}`;
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

/** RSK-06 (a mesma `Idempotency-Key` em cada reenvio do mesmo formulário). */
export async function createTreatment(
  riskId: string,
  body: CreateRiskTreatmentInput,
  idempotencyKey: string,
): Promise<RiskTreatmentDto> {
  return (
    await apiRequest<RiskTreatmentDto>(`/risks/${riskId}/treatments`, {
      method: 'POST',
      body,
      idempotencyKey,
    })
  ).data;
}

/** RSK-07 com a versão do tratamento (campos, `status` ou `sortOrder`). */
export async function updateTreatment(
  treatmentId: string,
  body: UpdateRiskTreatmentInput,
  version: number,
): Promise<RiskTreatmentDto> {
  return (
    await apiRequest<RiskTreatmentDto>(`/risk-treatments/${treatmentId}`, {
      method: 'PATCH',
      body,
      ifMatch: ifMatch(version),
    })
  ).data;
}

/** RSK-08 com a versão do tratamento (exclusão lógica). */
export async function deleteTreatment(treatmentId: string, version: number): Promise<void> {
  await apiRequest<unknown>(`/risk-treatments/${treatmentId}`, {
    method: 'DELETE',
    ifMatch: ifMatch(version),
  });
}

/**
 * RSK-11 (US-119) — aplica os riscos e tratamentos escolhidos da proposta de IA (a mesma
 * `Idempotency-Key` em cada reenvio da intenção). Riscos criados ficam "gerados por IA" até o RSK-12.
 */
export async function applyAiRisks(
  processId: string,
  body: ApplyAiRisksInput,
  context: IdempotentContext,
): Promise<ApplyAiRisksResultDto> {
  return (
    await apiRequest<ApplyAiRisksResultDto>(`/processes/${processId}/risks/ai-apply`, {
      method: 'POST',
      body,
      idempotencyKey: context.idempotencyKey,
      correlationId: context.correlationId,
    })
  ).data;
}

/** RSK-12 (US-119) — marca os riscos gerados por IA como revisados, com a versão vista de cada um. */
export async function reviewAiRisks(
  processId: string,
  risks: readonly Pick<RiskDto, 'id' | 'version'>[],
): Promise<ReviewAiRisksResultDto> {
  return (
    await apiRequest<ReviewAiRisksResultDto>(`/processes/${processId}/risks/ai-review`, {
      method: 'POST',
      body: {
        riskIds: risks.map((risk) => risk.id),
        expectedVersions: Object.fromEntries(risks.map((risk) => [risk.id, risk.version])),
      },
    })
  ).data;
}
