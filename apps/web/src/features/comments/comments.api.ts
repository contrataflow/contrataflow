import { commentListMetaSchema } from '@contrataflow/validation';
import type {
  CommentBody,
  CommentDto,
  CommentListMetaDto,
  CommentTargetType,
  CommentThreadDto,
  MentionCandidateDto,
} from '@contrataflow/validation';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

import { apiRequest } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

import { timelineKeys } from '../timeline/timeline.api';

/*
 * Comentários do processo (US-071 · SCR-006 aba "Comentários" e painel dos editores): CMT-01..04 de
 * api/12-comments-attachments.md. Chave `['t', tenantId, 'processes', id, 'comments', filtros]`
 * (sob a do processo: a invalidação do painel a alcança) com `useInfiniteQuery`; refetch ao focar a
 * janela e a cada 60 s com a aba visível. Mutações invalidam a timeline do processo.
 */

export const commentKeys = {
  all: (tenantId: string, processId: string) =>
    tenantKey(tenantId, 'processes', processId, 'comments'),
  list: (tenantId: string, processId: string, filters: CommentFilters) =>
    tenantKey(tenantId, 'processes', processId, 'comments', { ...filters }),
  mentionCandidates: (tenantId: string, processId: string, q: string) =>
    tenantKey(tenantId, 'processes', processId, 'mention-candidates', q),
};

/** FA-09: "Todos", "Do processo", "Deste documento", "Desta seção". */
export interface CommentFilters {
  readonly targetType?: CommentTargetType | undefined;
  readonly documentId?: string | undefined;
  readonly sectionKey?: string | undefined;
}

export interface CommentPage {
  readonly threads: readonly CommentThreadDto[];
  readonly meta: CommentListMetaDto;
}

/** Refetch periódico (60 s) só com a aba do navegador visível. */
export const COMMENTS_REFETCH_MS = 60_000;

const ifMatch = (version: number) => `"${String(version)}"`;

/** CMT-01. Resposta sem o `meta` esperado vira erro (a tela mostra "Tentar novamente"). */
export async function fetchComments(
  processId: string,
  options: {
    readonly filters?: CommentFilters;
    readonly cursor?: string | null | undefined;
    readonly parentId?: string | undefined;
    readonly limit?: number | undefined;
  } = {},
  signal?: AbortSignal,
): Promise<CommentPage> {
  const result = await apiRequest<CommentThreadDto[]>(`/processes/${processId}/comments`, {
    query: {
      ...options.filters,
      parentId: options.parentId,
      cursor: options.cursor ?? undefined,
      limit: options.limit,
    },
    signal,
  });
  const meta = commentListMetaSchema.safeParse(result.meta);
  if (!meta.success) throw new Error('Resposta de comentários sem o meta esperado.');
  return { threads: Array.isArray(result.data) ? result.data : [], meta: meta.data };
}

export function useCommentThreads(
  processId: string,
  filters: CommentFilters,
  options: { readonly enabled?: boolean } = {},
) {
  const tenantId = useTenantId();
  return useInfiniteQuery({
    queryKey: commentKeys.list(tenantId, processId, filters),
    queryFn: ({ pageParam, signal }) =>
      fetchComments(processId, { filters, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => (page.meta.hasMore ? page.meta.nextCursor : null),
    refetchOnWindowFocus: true,
    refetchInterval: () =>
      typeof document !== 'undefined' && document.visibilityState === 'visible'
        ? COMMENTS_REFETCH_MS
        : false,
    enabled: options.enabled ?? true,
    throwOnError: false,
  });
}

/** Recarrega os comentários e a timeline do processo depois de uma mutação. */
export function useInvalidateComments(processId: string) {
  const tenantId = useTenantId();
  const client = useQueryClient();
  return useCallback(
    () =>
      Promise.all([
        client.invalidateQueries({ queryKey: commentKeys.all(tenantId, processId) }),
        client.invalidateQueries({ queryKey: timelineKeys.all(tenantId, processId) }),
      ]),
    [client, tenantId, processId],
  );
}

export interface NewComment {
  readonly body: CommentBody;
  readonly targetType: CommentTargetType;
  readonly documentId?: string | undefined;
  readonly sectionKey?: string | undefined;
  readonly parentId?: string | undefined;
}

/** CMT-02 (a mesma `Idempotency-Key` em cada reenvio do mesmo texto — FA-08). */
export async function createComment(
  processId: string,
  body: NewComment,
  context: { readonly idempotencyKey: string; readonly correlationId: string },
): Promise<CommentDto> {
  return (
    await apiRequest<CommentDto>(`/processes/${processId}/comments`, {
      method: 'POST',
      body,
      idempotencyKey: context.idempotencyKey,
      correlationId: context.correlationId,
    })
  ).data;
}

/** CMT-03 com a versão do comentário. */
export async function updateComment(
  commentId: string,
  body: CommentBody,
  version: number,
): Promise<CommentDto> {
  return (
    await apiRequest<CommentDto>(`/comments/${commentId}`, {
      method: 'PATCH',
      body: { body },
      ifMatch: ifMatch(version),
    })
  ).data;
}

/** CMT-04: exclusão pelo autor (sem motivo) ou moderação (`reason` 10–1.000). */
export async function deleteComment(
  commentId: string,
  version: number,
  reason?: string,
): Promise<void> {
  await apiRequest<unknown>(`/comments/${commentId}`, {
    method: 'DELETE',
    ifMatch: ifMatch(version),
    ...(reason === undefined ? {} : { body: { reason } }),
  });
}

/** CMT-05 (US-072): candidatos de menção do processo (até 10). */
export async function fetchMentionCandidates(
  processId: string,
  q: string,
  signal?: AbortSignal,
): Promise<MentionCandidateDto[]> {
  const result = await apiRequest<MentionCandidateDto[]>(
    `/processes/${processId}/mention-candidates`,
    { query: { q }, signal },
  );
  return Array.isArray(result.data) ? result.data : [];
}

/** Espera entre teclas antes de buscar os candidatos (passo 2 — debounce). */
export const MENTION_DEBOUNCE_MS = 250;

/**
 * Candidatos de menção para a "@consulta" digitada (com debounce); `null` = sem consulta ativa. A
 * falha não derruba o compositor: o "@algo" segue como texto (estado de erro do autocomplete).
 */
export function useMentionCandidates(processId: string, query: string | null) {
  const tenantId = useTenantId();
  const [debounced, setDebounced] = useState(query);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(query);
    }, MENTION_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [query]);
  const q = debounced?.trim() ?? '';
  return useQuery({
    queryKey: commentKeys.mentionCandidates(tenantId, processId, q),
    queryFn: ({ signal }) => fetchMentionCandidates(processId, q, signal),
    enabled: query !== null && q.length >= 1,
    staleTime: 30_000,
    retry: false,
    throwOnError: false,
  });
}
