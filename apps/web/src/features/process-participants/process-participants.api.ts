import { processParticipantsMetaSchema } from '@contrataflow/validation';
import type {
  AddProcessParticipantInput,
  DepartmentLookupItem,
  ProcessParticipantDto,
  ProcessParticipantsMeta,
  UserLookupItem,
} from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';

import { apiRequest } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

/*
 * Participantes do processo (US-012 · SCR-006 aba "Participantes" — SCR-112 — e o botão "Seguir"
 * do cabeçalho): PRC-28..32 de api/02-processes.md e as buscas USR-02 (pessoas) e DEP-02
 * (unidades). Chave `['t', tenantId, 'processes', id, 'participants']` (sob a do processo: a
 * invalidação do painel a alcança). Nenhum `If-Match` (o recurso não expõe versão).
 */

export const participantKeys = {
  list: (tenantId: string, processId: string) =>
    tenantKey(tenantId, 'processes', processId, 'participants'),
  users: (tenantId: string, q: string) => tenantKey(tenantId, 'users', 'lookup', q),
  departments: (tenantId: string, q: string) => tenantKey(tenantId, 'departments', 'lookup', q),
};

export interface ParticipantList {
  readonly items: readonly ProcessParticipantDto[];
  readonly meta: ProcessParticipantsMeta;
}

const NO_META: ProcessParticipantsMeta = { canManage: false, me: null };

/** PRC-28. */
export async function fetchParticipants(
  processId: string,
  signal?: AbortSignal,
): Promise<ParticipantList> {
  const result = await apiRequest<ProcessParticipantDto[]>(`/processes/${processId}/participants`, {
    signal,
  });
  const meta = processParticipantsMetaSchema.safeParse(result.meta);
  return {
    items: Array.isArray(result.data) ? result.data : [],
    meta: meta.success ? meta.data : NO_META,
  };
}

export function useParticipants(processId: string) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: participantKeys.list(tenantId, processId),
    queryFn: ({ signal }) => fetchParticipants(processId, signal),
    refetchOnWindowFocus: true,
    throwOnError: false,
  });
}

/** PRC-29 (a mesma `Idempotency-Key` em cada reenvio do mesmo diálogo). */
export async function addParticipant(
  processId: string,
  body: AddProcessParticipantInput,
  idempotencyKey: string,
): Promise<ProcessParticipantDto> {
  return (
    await apiRequest<ProcessParticipantDto>(`/processes/${processId}/participants`, {
      method: 'POST',
      body,
      idempotencyKey,
    })
  ).data;
}

/** PRC-30 (motivo opcional). */
export async function removeParticipant(
  participantId: string,
  revocationReason: string | null,
): Promise<void> {
  await apiRequest<unknown>(`/process-participants/${participantId}`, {
    method: 'DELETE',
    body: revocationReason === null ? {} : { revocationReason },
  });
}

/** PRC-31. */
export async function followProcess(processId: string): Promise<ProcessParticipantDto> {
  return (
    await apiRequest<ProcessParticipantDto>(`/processes/${processId}/follow`, { method: 'POST' })
  ).data;
}

/** PRC-32. */
export async function unfollowProcess(processId: string): Promise<void> {
  await apiRequest<unknown>(`/processes/${processId}/follow`, { method: 'DELETE' });
}

/** USR-02: pessoas ativas do tenant (mín. 2 caracteres). */
export async function lookupUsers(q: string, signal?: AbortSignal): Promise<UserLookupItem[]> {
  return (await apiRequest<UserLookupItem[]>('/users/lookup', { query: { q }, signal })).data;
}

/** DEP-02: unidades ativas do tenant por nome. */
export async function lookupUnits(
  q: string,
  signal?: AbortSignal,
): Promise<DepartmentLookupItem[]> {
  return (await apiRequest<DepartmentLookupItem[]>('/departments/lookup', { query: { q }, signal }))
    .data;
}
