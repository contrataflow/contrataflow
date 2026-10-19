import type {
  ApprovalDto,
  ApprovalMeta,
  DecideApprovalInput,
  DecidedApprovalDto,
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
 * `['t', tenantId, 'approvals']`, o processo e a caixa de tarefas.
 */

export const approvalKeys = {
  all: (tenantId: string) => tenantKey(tenantId, 'approvals'),
  detail: (tenantId: string, approvalId: string) => tenantKey(tenantId, 'approvals', approvalId),
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
