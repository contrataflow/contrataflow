import type {
  DepartmentLookupItem,
  ForwardProcessInput,
  ForwardedProcessDto,
} from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';
import type { RetryOptions } from '@/lib/api/client';
import { useIdempotentMutation } from '@/lib/api/use-idempotent-mutation';
import type { IdempotentContext } from '@/lib/api/use-idempotent-mutation';
import { tenantKey } from '@/lib/query/keys';

/*
 * Encaminhamento do processo (US-047 · SCR-103): PRC-19 (`POST /processes/{id}/forward`) e a busca
 * de unidades DEP-02 filtrada pelo órgão do processo. As leituras do painel (PRC-04/08/09/10 e
 * DOC-01) vêm dos módulos donos. Chaves `['t', tenantId, …]` (RN-FND-90).
 */

export const forwardKeys = {
  departments: (tenantId: string, organizationId: string, q: string) =>
    tenantKey(tenantId, 'departments', 'lookup', organizationId, q),
};

/** `If-Match` com a `version` lida no PRC-04. */
const ifMatchOf = (version: number) => `"${String(version)}"`;

/** PRC-19: a mesma `Idempotency-Key` vale para as retentativas automáticas da mesma intenção. */
export async function forwardProcess(
  processId: string,
  body: ForwardProcessInput,
  version: number,
  context: IdempotentContext,
): Promise<ForwardedProcessDto> {
  const result = await apiRequest<ForwardedProcessDto>(`/processes/${processId}/forward`, {
    method: 'POST',
    body,
    ifMatch: ifMatchOf(version),
    idempotencyKey: context.idempotencyKey,
    correlationId: context.correlationId,
  });
  return result.data;
}

export interface ForwardVariables {
  readonly processId: string;
  readonly body: ForwardProcessInput;
  /** `version` do PRC-04 (o `If-Match`). */
  readonly version: number;
}

/**
 * Mutação do encaminhamento: chave de idempotência por intenção. A intenção termina com a mutação,
 * então o reenvio após `WARNINGS_NOT_ACKNOWLEDGED`/`TRANSITION_BLOCKED` (corpo novo) usa chave nova.
 */
export function useForwardProcess(retry?: RetryOptions) {
  return useIdempotentMutation<ForwardVariables, ForwardedProcessDto>({
    mutationFn: (variables, context) =>
      forwardProcess(variables.processId, variables.body, variables.version, context),
    retry,
  });
}

/** DEP-02 do órgão do processo: até 50 unidades ativas; `q` (≥ 2 caracteres) filtra por nome. */
export async function lookupOrganizationDepartments(
  organizationId: string,
  q: string,
  signal?: AbortSignal,
): Promise<DepartmentLookupItem[]> {
  const result = await apiRequest<DepartmentLookupItem[]>('/departments/lookup', {
    query: { organizationId, q: q.trim().length >= 2 ? q.trim() : undefined },
    signal,
  });
  return Array.isArray(result.data) ? result.data : [];
}
