'use client';

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@contrataflow/ui';
import type { CommentDto, CommentThreadDto } from '@contrataflow/validation';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNow, useTranslations } from 'next-intl';
import { useState } from 'react';

import { useShellSession } from '@/lib/session/session-context';

import { CommentBodyView } from './comment-body';
import { CommentComposer } from './comment-composer';
import { relativeTimeOf } from './comments-model';
import { commentKeys, fetchComments } from './comments.api';

/** Ações do item, executadas pelo painel (diálogos e recarga). */
export interface CommentActions {
  readonly processId: string;
  readonly isBudgetConfidential: boolean;
  /** Pode responder (compositor disponível — RN-CMT-07/08). */
  readonly canReply: boolean;
  readonly onDelete: (comment: CommentDto) => void;
  readonly onModerate: (comment: CommentDto) => void;
  /** Publicação/edição concluída (anúncio + recarga). */
  readonly onSaved: (kind: 'published' | 'updated') => void;
  /** Recusa por estado: recarrega a lista. */
  readonly onStale: () => void;
}

function formatAbsolute(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(iso));
}

function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', { timeStyle: 'short', timeZone }).format(new Date(iso));
}

/** Alvo do comentário: "Processo" ou "ETP 0003/2026 › Requisitos da contratação". */
function targetLabel(comment: CommentDto, processLabel: string): string {
  if (comment.document === null) return processLabel;
  const document = comment.document.code ?? comment.document.title;
  return comment.sectionKey === null ? document : `${document} › ${comment.sectionKey}`;
}

/**
 * `CommentItem` (US-071): `article` rotulado "Comentário de {autor}, {data}", autor e unidade, data
 * relativa (absoluta no `title`), alvo, texto formatado (ou o estado excluído/mascarado) e o menu
 * "Mais" — Editar (até HH:mm), Excluir, Remover por moderação — conforme as ações da API.
 */
export function CommentItem({
  comment,
  actions,
  onReply,
}: {
  readonly comment: CommentDto;
  readonly actions: CommentActions;
  readonly onReply?: (() => void) | undefined;
}) {
  const t = useTranslations('comments.item');
  const session = useShellSession();
  const timeZone = session.activeTenant.timezone;
  const now = useNow({ updateInterval: 60_000 });
  const [editing, setEditing] = useState(false);
  const absolute = formatAbsolute(comment.createdAt, timeZone);
  const relative = relativeTimeOf(comment.createdAt, now);
  const relativeLabel =
    relative.unit === 'now'
      ? t('relative.now')
      : t(`relative.${relative.unit}`, { count: relative.count });
  const hasMenu = comment.canEdit || comment.canDelete || comment.canModerate;

  let content;
  if (comment.isDeleted) {
    content = (
      <div className="flex flex-col gap-1 text-sm text-muted-foreground italic">
        <p>{comment.deletedByModerator ? t('deletedByModerator') : t('deletedByAuthor')}</p>
        {comment.deletionReason ? (
          <p className="not-italic">{t('moderationReason', { reason: comment.deletionReason })}</p>
        ) : null}
      </div>
    );
  } else if (comment.bodyMasked || comment.body === null) {
    content = <p className="text-sm text-muted-foreground italic">{t('masked')}</p>;
  } else if (editing) {
    content = (
      <CommentComposer
        mode="edit"
        comment={comment}
        processId={actions.processId}
        isBudgetConfidential={actions.isBudgetConfidential}
        focusOnMount
        onCancel={() => {
          setEditing(false);
        }}
        onStale={actions.onStale}
        onDone={() => {
          setEditing(false);
          actions.onSaved('updated');
        }}
      />
    );
  } else {
    content = <CommentBodyView body={comment.body} />;
  }

  return (
    <article
      aria-label={t('label', { author: comment.author.name, date: absolute })}
      className="flex min-w-0 flex-col gap-2"
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <p className="text-sm font-medium break-words">
            {comment.author.name}
            {comment.author.departmentName ? (
              <span className="font-normal text-muted-foreground">
                {' · '}
                {comment.author.departmentName}
              </span>
            ) : null}
          </p>
          <p className="text-xs text-muted-foreground">
            <time dateTime={comment.createdAt} title={absolute}>
              {relativeLabel}
            </time>
            {' · '}
            {targetLabel(comment, t('process'))}
            {comment.editedAt !== null && !comment.isDeleted ? ` ${t('edited')}` : null}
          </p>
        </div>
        {hasMenu && !editing ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                aria-label={t('more', { author: comment.author.name })}
              >
                ⋯
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {comment.canEdit && comment.editableUntil !== null ? (
                <DropdownMenuItem
                  onSelect={() => {
                    setEditing(true);
                  }}
                >
                  {t('edit', { time: formatTime(comment.editableUntil, timeZone) })}
                </DropdownMenuItem>
              ) : null}
              {comment.canDelete ? (
                <DropdownMenuItem
                  onSelect={() => {
                    actions.onDelete(comment);
                  }}
                >
                  {t('delete')}
                </DropdownMenuItem>
              ) : null}
              {comment.canModerate ? (
                <DropdownMenuItem
                  onSelect={() => {
                    actions.onModerate(comment);
                  }}
                >
                  {t('moderate')}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </header>
      {content}
      {onReply && !editing ? (
        <div>
          <Button size="sm" variant="ghost" onClick={onReply}>
            {t('reply')}
          </Button>
        </div>
      ) : null}
    </article>
  );
}

/** FA-10: respostas além das 20 embutidas (`CMT-01?parentId=`), por cursor. */
function useMoreReplies(processId: string, thread: CommentThreadDto, enabled: boolean) {
  const tenantId = useShellSession().activeTenant.id;
  return useInfiniteQuery({
    queryKey: [...commentKeys.all(tenantId, processId), 'replies', thread.id],
    queryFn: ({ pageParam, signal }) =>
      fetchComments(processId, { parentId: thread.id, cursor: pageParam, limit: 100 }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => (page.meta.hasMore ? page.meta.nextCursor : null),
    enabled,
    throwOnError: false,
  });
}

/**
 * `CommentThread`: comentário raiz, respostas de um nível (até 20 embutidas; "Ver mais N
 * respostas" busca as demais) e o compositor inline de resposta (FA-01).
 */
export function CommentThread({
  thread,
  actions,
}: {
  readonly thread: CommentThreadDto;
  readonly actions: CommentActions;
}) {
  const t = useTranslations('comments.item');
  const [replying, setReplying] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const more = useMoreReplies(actions.processId, thread, expanded);
  const replies: readonly CommentDto[] =
    expanded && more.data ? more.data.pages.flatMap((page) => page.threads) : thread.replies;
  const hidden = thread.replyCount - replies.length;
  const canReply = actions.canReply && !thread.isDeleted;

  return (
    <li className="flex flex-col gap-3 rounded-card border border-border p-3">
      <CommentItem
        comment={thread}
        actions={actions}
        onReply={
          canReply && !replying
            ? () => {
                setReplying(true);
              }
            : undefined
        }
      />
      {replies.length > 0 || hidden > 0 ? (
        <ul
          aria-label={t('repliesLabel')}
          className="ml-4 flex flex-col gap-3 border-l border-border pl-3"
        >
          {replies.map((reply) => (
            <li key={reply.id}>
              <CommentItem comment={reply} actions={actions} />
            </li>
          ))}
          {hidden > 0 ? (
            <li>
              <Button
                size="sm"
                variant="ghost"
                disabled={more.isFetching}
                onClick={() => {
                  if (!expanded) setExpanded(true);
                  else void more.fetchNextPage();
                }}
              >
                {t('moreReplies', { count: hidden })}
              </Button>
            </li>
          ) : null}
        </ul>
      ) : null}
      {replying ? (
        <div className="ml-4">
          <CommentComposer
            mode="reply"
            parent={thread}
            processId={actions.processId}
            isBudgetConfidential={actions.isBudgetConfidential}
            focusOnMount
            onCancel={() => {
              setReplying(false);
            }}
            onStale={actions.onStale}
            onDone={() => {
              setReplying(false);
              if (expanded) void more.refetch();
              actions.onSaved('published');
            }}
          />
        </div>
      ) : null}
    </li>
  );
}
