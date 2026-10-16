import type { WorkflowDto } from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';
import type { ApiResult } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';

/*
 * Workflows (US-042 · SCR-034): WF-01 (lista) e WF-05 (tornar padrão) de api/10-workflow.md. As
 * chaves seguem a convenção `['t', tenantId, …]` (RN-FND-90).
 */

export const workflowKeys = {
  all: (tenantId: string) => tenantKey(tenantId, 'workflows'),
  list: (tenantId: string) => tenantKey(tenantId, 'workflows', 'list'),
};

/** Staleness das telas de configuração (architecture.md §8.5). */
export const WORKFLOWS_STALE_TIME_MS = 60_000;

/** WF-01: todos os workflows do tenant (até 100), na ordem da aplicabilidade. */
export function fetchWorkflows(signal?: AbortSignal): Promise<ApiResult<WorkflowDto[]>> {
  return apiRequest<WorkflowDto[]>('/workflows', { query: { pageSize: 100 }, signal });
}

/** WF-05: tornar padrão com a versão lida em `If-Match` (RN-WF-42). */
export function setDefaultWorkflow(id: string, version: number): Promise<ApiResult<WorkflowDto>> {
  return apiRequest<WorkflowDto>(`/workflows/${id}/set-default`, {
    method: 'POST',
    ifMatch: `"${version}"`,
  });
}

/** RN-WF-41: só workflow ativo e com versão publicada pode ser o padrão. */
export function canBecomeDefault(workflow: WorkflowDto): boolean {
  return workflow.isActive && workflow.currentPublishedVersion !== null;
}

export type Applicability =
  | { readonly kind: 'ANY' }
  | { readonly kind: 'MODALITIES'; readonly codes: readonly string[] }
  | { readonly kind: 'CUSTOM' };

/**
 * Resumo legível da `applicabilityRule` (somente leitura na lista): nula = qualquer processo; a
 * forma semeada `{ in: [{ var: 'process.modalityCode' }, [...]] }` vira a lista de modalidades.
 */
export function describeApplicability(rule: unknown): Applicability {
  if (rule === null || rule === undefined) return { kind: 'ANY' };
  if (typeof rule === 'object' && 'in' in rule && Array.isArray(rule.in)) {
    const [variable, codes] = rule.in as unknown[];
    const isModality =
      typeof variable === 'object' &&
      variable !== null &&
      'var' in variable &&
      variable.var === 'process.modalityCode';
    if (isModality && Array.isArray(codes) && codes.every((code) => typeof code === 'string')) {
      return { kind: 'MODALITIES', codes };
    }
  }
  return { kind: 'CUSTOM' };
}
