import type { AssignProcessInput, ProcessDto, UserLookupItem } from '@contrataflow/validation';
import { useMutation, useQuery } from '@tanstack/react-query';

import { apiRequest } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

/*
 * Atribuir/reatribuir o responsável (US-050 · SCR-115): PRC-22 (`POST /processes/{id}/assign`) com
 * `If-Match` (versão do PRC-04) e SEM `Idempotency-Key` — o reenvio já aplicado cai no 412 (FA-04).
 * Os membros da unidade atual vêm do USR-02 com `departmentId` (até 50 lotados, vínculo ativo).
 */

export const assignKeys = {
  members: (tenantId: string, departmentId: string) =>
    tenantKey(tenantId, 'users', 'lookup', 'department', departmentId),
};

export async function assignProcess(
  processId: string,
  body: AssignProcessInput,
  version: number,
): Promise<ProcessDto> {
  const result = await apiRequest<ProcessDto>(`/processes/${processId}/assign`, {
    method: 'POST',
    body,
    ifMatch: `"${String(version)}"`,
  });
  return result.data;
}

export interface AssignVariables {
  readonly processId: string;
  readonly body: AssignProcessInput;
  /** `version` do PRC-04 (o `If-Match`). */
  readonly version: number;
}

export function useAssignMutation() {
  return useMutation({
    mutationFn: ({ processId, body, version }: AssignVariables) =>
      assignProcess(processId, body, version),
  });
}

/** USR-02 com `departmentId`: os lotados ativos da unidade, por nome. */
export async function lookupDepartmentMembers(
  departmentId: string,
  signal?: AbortSignal,
): Promise<UserLookupItem[]> {
  const result = await apiRequest<UserLookupItem[]>('/users/lookup', {
    query: { departmentId },
    signal,
  });
  return Array.isArray(result.data) ? result.data : [];
}

/** Membros da unidade atual, lidos só com o diálogo aberto. */
export function useDepartmentMembers(departmentId: string | undefined, enabled: boolean) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: assignKeys.members(tenantId, departmentId ?? ''),
    queryFn: ({ signal }) => lookupDepartmentMembers(departmentId ?? '', signal),
    enabled: enabled && departmentId !== undefined,
    throwOnError: false,
  });
}
