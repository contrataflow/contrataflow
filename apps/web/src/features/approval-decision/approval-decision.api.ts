import type {
  ApprovalDto,
  ApprovalMeta,
  DecideApprovalInput,
  DecidedApprovalDto,
  DepartmentLookupItem,
  ReassignApprovalInput,
  UserLookupItem,
  WithdrawApprovalInput,
  WithdrawnApprovalDto,
} from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';

import { apiRequest } from '@/lib/api/client';
import type { RetryOptions } from '@/lib/api/client';
import { useIdempotentMutation } from '@/lib/api/use-idempotent-mutation';
import type { IdempotentContext } from '@/lib/api/use-idempotent-mutation';
import { tenantKey } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

/*
 * Decidir aprovação (US-052 · SCR-015): APV-02 (`GET /approvals/{id}`) e APV-03
 * (`POST /approvals/{id}/decide`) de api/11-approvals-inbox.md. Chaves
 * `['t', tenantId, 'approvals', id]` (RN-FND-90); depois da decisão se invalida o prefixo
 * `['t', tenantId, 'approvals']`, o processo e a caixa de tarefas. US-053: APV-04 (retirar) e APV-05
 * (redirecionar), com as buscas de novo aprovador (USR-02 e DEP-02).
 */

export const approvalKeys = {
  all: (tenantId: string) => tenantKey(tenantId, 'approvals'),
  detail: (tenantId: string, approvalId: string) => tenantKey(tenantId, 'approvals', approvalId),
  /** Busca de novo aprovador (USR-02/DEP-02), por tipo e termo. */
  candidates: (tenantId: string, type: string, q: string) =>
    tenantKey(tenantId, 'approvals', 'candidates', type, q),
};

/** APV-02 já separado: a aprovação, o `meta` (ações e opções de decisão) e a `ETag`. */
export interface ApprovalView {
  readonly approval: ApprovalDto;
  readonly meta: ApprovalMeta;
  readonly etag: string | null;
}

const EMPTY_META: ApprovalMeta = {
  allowedActions: [],
  decisionOptions: [],
  decidesAsDeputy: false,
  decisionBlocker: null,
};

/** APV-02: `If-Match` das ações é `data.version`; a `ETag` vem junto para conferência. */
export async function fetchApproval(
  approvalId: string,
  signal?: AbortSignal,
): Promise<ApprovalView> {
  const result = await apiRequest<ApprovalDto>(`/approvals/${approvalId}`, { signal });
  const meta = result.meta as Partial<ApprovalMeta>;
  return {
    approval: result.data,
    meta: {
      allowedActions: meta.allowedActions ?? EMPTY_META.allowedActions,
      decisionOptions: meta.decisionOptions ?? EMPTY_META.decisionOptions,
      decidesAsDeputy: meta.decidesAsDeputy ?? EMPTY_META.decidesAsDeputy,
      decisionBlocker: meta.decisionBlocker ?? EMPTY_META.decisionBlocker,
    },
    etag: result.meta.etag,
  };
}

/**
 * SCR-015: o detalhe volta a ser lido ao focar a janela (a aprovação pode ter sido decidida por
 * outra pessoa) e os erros ficam na tela ("Tentar novamente"), não no boundary do segmento.
 */
export function useApproval(approvalId: string) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: approvalKeys.detail(tenantId, approvalId),
    queryFn: ({ signal }) => fetchApproval(approvalId, signal),
    refetchOnWindowFocus: 'always',
    throwOnError: false,
  });
}

/** APV-03: a mesma `Idempotency-Key` vale para as retentativas automáticas (DEC-105). */
export async function decideApproval(
  approvalId: string,
  body: DecideApprovalInput,
  version: number,
  context: IdempotentContext,
): Promise<DecidedApprovalDto> {
  const result = await apiRequest<DecidedApprovalDto>(`/approvals/${approvalId}/decide`, {
    method: 'POST',
    body,
    ifMatch: `"${String(version)}"`,
    idempotencyKey: context.idempotencyKey,
    correlationId: context.correlationId,
  });
  return result.data;
}

export interface DecideVariables {
  readonly approvalId: string;
  readonly body: DecideApprovalInput;
  /** `version` da última leitura (APV-02): o `If-Match`. */
  readonly version: number;
}

/** Mutação da decisão: chave de idempotência por intenção (reenvios da falha de rede). */
export function useDecideApproval(retry?: RetryOptions) {
  return useIdempotentMutation<DecideVariables, DecidedApprovalDto>({
    mutationFn: (variables, context) =>
      decideApproval(variables.approvalId, variables.body, variables.version, context),
    retry,
  });
}

/** APV-04: retirar a aprovação pendente (`If-Match` = `version` do APV-02). */
export async function withdrawApproval(
  approvalId: string,
  body: WithdrawApprovalInput,
  version: number,
  context: IdempotentContext,
): Promise<WithdrawnApprovalDto> {
  const result = await apiRequest<WithdrawnApprovalDto>(`/approvals/${approvalId}/withdraw`, {
    method: 'POST',
    body,
    ifMatch: `"${String(version)}"`,
    idempotencyKey: context.idempotencyKey,
    correlationId: context.correlationId,
  });
  return result.data;
}

export interface WithdrawVariables {
  readonly approvalId: string;
  readonly body: WithdrawApprovalInput;
  readonly version: number;
}

export function useWithdrawApproval(retry?: RetryOptions) {
  return useIdempotentMutation<WithdrawVariables, WithdrawnApprovalDto>({
    mutationFn: (variables, context) =>
      withdrawApproval(variables.approvalId, variables.body, variables.version, context),
    retry,
  });
}

/** APV-05: redirecionar a aprovação pendente para outro aprovador. */
export async function reassignApproval(
  approvalId: string,
  body: ReassignApprovalInput,
  version: number,
  context: IdempotentContext,
): Promise<ApprovalDto> {
  const result = await apiRequest<ApprovalDto>(`/approvals/${approvalId}/reassign`, {
    method: 'POST',
    body,
    ifMatch: `"${String(version)}"`,
    idempotencyKey: context.idempotencyKey,
    correlationId: context.correlationId,
  });
  return result.data;
}

export interface ReassignVariables {
  readonly approvalId: string;
  readonly body: ReassignApprovalInput;
  readonly version: number;
}

export function useReassignApproval(retry?: RetryOptions) {
  return useIdempotentMutation<ReassignVariables, ApprovalDto>({
    mutationFn: (variables, context) =>
      reassignApproval(variables.approvalId, variables.body, variables.version, context),
    retry,
  });
}

/** Candidato a novo aprovador, já no formato da lista do diálogo. */
export interface ApproverCandidate {
  readonly id: string;
  readonly label: string;
  readonly hint: string | null;
}

/** USR-02 (pessoas com vínculo ativo) ou DEP-02 (unidades ativas), pelo termo (≥ 2). */
export async function lookupApproverCandidates(
  type: 'USER' | 'DEPARTMENT_HEAD',
  q: string,
  signal?: AbortSignal,
): Promise<ApproverCandidate[]> {
  if (type === 'USER') {
    const result = await apiRequest<UserLookupItem[]>('/users/lookup', { query: { q }, signal });
    const users = Array.isArray(result.data) ? result.data : [];
    return users.map((user) => ({ id: user.id, label: user.name, hint: user.email }));
  }
  const result = await apiRequest<DepartmentLookupItem[]>('/departments/lookup', {
    query: { q },
    signal,
  });
  const departments = Array.isArray(result.data) ? result.data : [];
  return departments.map((department) => ({
    id: department.id,
    label: department.name,
    hint: null,
  }));
}

/** Busca assíncrona de candidatos (termo já com debounce); só com 2+ caracteres. */
export function useApproverCandidates(type: 'USER' | 'DEPARTMENT_HEAD', q: string) {
  const tenantId = useTenantId();
  const term = q.trim();
  return useQuery({
    queryKey: approvalKeys.candidates(tenantId, type, term),
    queryFn: ({ signal }) => lookupApproverCandidates(type, term, signal),
    enabled: term.length >= 2,
    throwOnError: false,
  });
}
