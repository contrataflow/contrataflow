import type { DayCountType } from '@contrataflow/types';
import type {
  ResumeMeta,
  ResumeProcessInput,
  SuspendProcessInput,
  SuspensionProcessDto,
} from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';

import { apiRequest } from '@/lib/api/client';
import type { RetryOptions } from '@/lib/api/client';
import { useIdempotentMutation } from '@/lib/api/use-idempotent-mutation';
import type { IdempotentContext } from '@/lib/api/use-idempotent-mutation';
import { tenantKey } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

import type { ExtensionQuery } from './suspension-model';

/*
 * Suspender e retomar o processo (US-008 · SCR-116): PRC-23 (`POST /processes/{id}/suspend`) e
 * PRC-24 (`/resume`), com `If-Match` (versão do PRC-04) e `Idempotency-Key` por intenção; a prévia
 * do novo prazo da retomada usa o calendário do tenant (CAL-05 e CAL-06) e é confirmada pela
 * resposta da API (`meta.extendedBy`/`newDueAt`).
 */

/** PRC-23: a mesma `Idempotency-Key` vale para as retentativas automáticas. */
export async function suspendProcess(
  processId: string,
  body: SuspendProcessInput,
  version: number,
  context: IdempotentContext,
): Promise<SuspensionProcessDto> {
  const result = await apiRequest<SuspensionProcessDto>(`/processes/${processId}/suspend`, {
    method: 'POST',
    body,
    ifMatch: `"${String(version)}"`,
    idempotencyKey: context.idempotencyKey,
    correlationId: context.correlationId,
  });
  return result.data;
}

export interface ResumedProcess {
  readonly process: SuspensionProcessDto;
  readonly meta: ResumeMeta;
}

/** PRC-24: o processo com o status restaurado e os dias acrescidos ao prazo. */
export async function resumeProcess(
  processId: string,
  body: ResumeProcessInput,
  version: number,
  context: IdempotentContext,
): Promise<ResumedProcess> {
  const result = await apiRequest<SuspensionProcessDto>(`/processes/${processId}/resume`, {
    method: 'POST',
    body,
    ifMatch: `"${String(version)}"`,
    idempotencyKey: context.idempotencyKey,
    correlationId: context.correlationId,
  });
  return { process: result.data, meta: result.meta as unknown as ResumeMeta };
}

export interface LifecycleVariables<B> {
  readonly processId: string;
  readonly body: B;
  /** `version` do PRC-04 (o `If-Match`). */
  readonly version: number;
}

export function useSuspendProcess(retry?: RetryOptions) {
  return useIdempotentMutation<LifecycleVariables<SuspendProcessInput>, SuspensionProcessDto>({
    mutationFn: (variables, context) =>
      suspendProcess(variables.processId, variables.body, variables.version, context),
    retry,
  });
}

export function useResumeProcess(retry?: RetryOptions) {
  return useIdempotentMutation<LifecycleVariables<ResumeProcessInput>, ResumedProcess>({
    mutationFn: (variables, context) =>
      resumeProcess(variables.processId, variables.body, variables.version, context),
    retry,
  });
}

/** Prévia da retomada: dias acrescidos e o novo prazo (`null` enquanto calcula ou sem prazo). */
export interface ResumePreview {
  readonly days: number | null;
  readonly newDueAt: string | null;
  readonly isPending: boolean;
  readonly isError: boolean;
}

/** CAL-05 (dias úteis do período) e CAL-06 (prazo + dias), só com o diálogo aberto. */
export function useResumePreview(input: {
  readonly enabled: boolean;
  readonly query: ExtensionQuery;
  readonly dueAt: string | null;
  readonly slaType: DayCountType;
}): ResumePreview {
  const tenantId = useTenantId();
  const { query } = input;
  const business = useQuery({
    queryKey: tenantKey(
      tenantId,
      'calendar',
      'business-days',
      query.kind === 'business' ? `${query.from}:${query.to}` : 'none',
    ),
    queryFn: async ({ signal }) => {
      if (query.kind !== 'business') return 0;
      const result = await apiRequest<{ businessDays: number }>('/calendar/business-days', {
        query: { from: query.from, to: query.to },
        signal,
      });
      return result.data.businessDays;
    },
    enabled: input.enabled && query.kind === 'business',
    throwOnError: false,
  });
  const days =
    query.kind === 'none' ? 0 : query.kind === 'calendar' ? query.days : (business.data ?? null);
  const due = useQuery({
    queryKey: tenantKey(
      tenantId,
      'calendar',
      'add-business-days',
      `${input.dueAt ?? 'none'}:${String(days)}:${input.slaType}`,
    ),
    queryFn: async ({ signal }) => {
      const result = await apiRequest<{ dueDateTime: string }>('/calendar/add-business-days', {
        method: 'POST',
        body: {
          fromDateTime: input.dueAt ?? '',
          businessDays: days ?? 0,
          dayCountType: input.slaType,
        },
        signal,
      });
      return result.data.dueDateTime;
    },
    enabled: input.enabled && input.dueAt !== null && days !== null && days > 0,
    throwOnError: false,
  });
  const newDueAt = input.dueAt === null ? null : days === 0 ? input.dueAt : (due.data ?? null);
  return {
    days,
    newDueAt,
    isPending: (query.kind === 'business' && business.isPending) || (days !== 0 && due.isPending),
    isError: business.isError || due.isError,
  };
}
