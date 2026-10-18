'use client';

import { Alert, Button, Skeleton } from '@contrataflow/ui';
import type { CommentDto, CommentTargetType } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { ApiError } from '@/lib/api/api-error';

import { CommentComposer } from './comment-composer';
import { DeleteCommentDialog, ModerationDialog } from './comment-dialogs';
import { CommentThread } from './comment-thread';
import type { CommentActions } from './comment-thread';
import { useCommentThreads, useInvalidateComments } from './comments.api';
import type { CommentFilters } from './comments.api';

/** Documento de origem do painel (editores e SCR-105). */
export interface CommentsDocumentContext {
  readonly id: string;
  readonly label: string;
  /** Seções do template (âncora opcional); vazio no documento externo. */
  readonly sections: readonly { readonly key: string; readonly title: string }[];
}

type FilterKey = 'all' | 'process' | 'document' | 'section';

function filtersOf(
  key: FilterKey,
  document: CommentsDocumentContext | null,
  sectionKey: string | null,
): CommentFilters {
  if (key === 'process') return { targetType: 'PROCESS' };
  if (key === 'document' && document) return { targetType: 'DOCUMENT', documentId: document.id };
  if (key === 'section' && document && sectionKey) {
    return { targetType: 'DOCUMENT', documentId: document.id, sectionKey };
  }
  return {};
}

/** `SectionCommentBadge`: contagem por seção, que filtra o painel pela seção. */
export function SectionCommentBadge({
  title,
  count,
  selected,
  onSelect,
}: {
  readonly title: string;
  readonly count: number;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const t = useTranslations('comments.panel');
  return (
    <Button
      size="sm"
      variant={selected ? 'secondary' : 'ghost'}
      aria-pressed={selected}
      onClick={onSelect}
    >
      {t('sectionBadge', { section: title, count })}
    </Button>
  );
}

/**
 * `CommentsPanel` (US-071 · SCR-006 aba "Comentários" e painel lateral dos editores): compositor
 * (ou o aviso de somente leitura — FA-05 · "Sem permissão"), filtros (FA-09), threads com
 * paginação, skeleton, vazio e erro com "Tentar novamente"; anuncia publicação/remoção em
 * `aria-live`. No editor, o alvo vem preenchido (`DOCUMENT`, documento e seção).
 */
export function CommentsPanel({
  processId,
  document = null,
  highlightedId = null,
}: {
  readonly processId: string;
  readonly document?: CommentsDocumentContext | null;
  /** `?comentario=` do link da notificação `MENTIONED` (US-072). */
  readonly highlightedId?: string | null;
}) {
  const t = useTranslations('comments.panel');
  const [filter, setFilter] = useState<FilterKey>(document ? 'document' : 'all');
  const [sectionKey, setSectionKey] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [deleting, setDeleting] = useState<CommentDto | null>(null);
  const [moderating, setModerating] = useState<CommentDto | null>(null);
  const filters = useMemo(
    () => filtersOf(filter, document, sectionKey),
    [filter, document, sectionKey],
  );
  const query = useCommentThreads(processId, filters);
  const invalidate = useInvalidateComments(processId);
  // Contagem por seção a partir da lista do documento (raízes carregadas).
  const documentQuery = useCommentThreads(
    processId,
    { targetType: 'DOCUMENT', documentId: document?.id },
    { enabled: document !== null && document.sections.length > 0 },
  );

  const first = query.data?.pages[0];
  const meta = first?.meta;
  const threads = query.data?.pages.flatMap((page) => page.threads) ?? [];
  const canComment = meta?.canComment === true;
  const isBudgetConfidential = meta?.isBudgetConfidential === true;

  const refresh = () => {
    void invalidate();
  };
  const actions: CommentActions = {
    processId,
    isBudgetConfidential,
    canReply: canComment,
    onDelete: setDeleting,
    onModerate: setModerating,
    onSaved: (kind) => {
      setAnnouncement(t(kind));
      refresh();
    },
    onStale: refresh,
    highlightedId,
  };

  const target: { targetType: CommentTargetType; documentId?: string; sectionKey?: string } =
    document
      ? {
          targetType: 'DOCUMENT',
          documentId: document.id,
          ...(filter === 'section' && sectionKey ? { sectionKey } : {}),
        }
      : { targetType: 'PROCESS' };

  const sectionCounts = new Map<string, number>();
  for (const page of documentQuery.data?.pages ?? []) {
    for (const thread of page.threads) {
      if (thread.sectionKey !== null && !thread.isDeleted) {
        sectionCounts.set(thread.sectionKey, (sectionCounts.get(thread.sectionKey) ?? 0) + 1);
      }
    }
  }

  const filterKeys: readonly FilterKey[] = document
    ? ['all', 'process', 'document', ...(sectionKey ? (['section'] as const) : [])]
    : ['all', 'process'];

  let body;
  if (query.isPending) {
    body = (
      <div role="status" className="flex flex-col gap-3">
        <span className="sr-only">{t('loading')}</span>
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  } else if (query.isError && threads.length === 0) {
    const correlationId =
      query.error instanceof ApiError ? (query.error.correlationId ?? '—') : '—';
    body = (
      <Alert tone="error" title={t('loadFailed')}>
        <p className="text-xs">{correlationId}</p>
        <Button
          size="sm"
          variant="secondary"
          className="mt-2"
          onClick={() => {
            void query.refetch();
          }}
        >
          {t('retry')}
        </Button>
      </Alert>
    );
  } else if (threads.length === 0) {
    body = <p className="text-sm text-muted-foreground">{t('empty')}</p>;
  } else {
    body = (
      <ol className="flex flex-col gap-3">
        {threads.map((thread) => (
          <CommentThread key={thread.id} thread={thread} actions={actions} />
        ))}
      </ol>
    );
  }

  return (
    <section aria-label={t('title')} className="flex min-w-0 flex-col gap-4">
      <h2 className="text-lg font-semibold">{t('title')}</h2>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      {meta === undefined ? null : meta.readOnly ? (
        <Alert tone="info" live={false} title={t('readOnlyProcess')} />
      ) : canComment ? (
        <CommentComposer
          mode="create"
          processId={processId}
          target={target}
          sections={document?.sections}
          isBudgetConfidential={isBudgetConfidential}
          onStale={refresh}
          onDone={() => {
            setAnnouncement(t('published'));
            refresh();
          }}
        />
      ) : (
        <Alert tone="info" live={false} title={t('readOnlyPermission')} />
      )}
      <div role="group" aria-label={t('filtersLabel')} className="flex flex-wrap gap-1">
        {filterKeys.map((key) => (
          <Button
            key={key}
            size="sm"
            variant={filter === key ? 'secondary' : 'ghost'}
            aria-pressed={filter === key}
            onClick={() => {
              setFilter(key);
            }}
          >
            {t(`filters.${key}`)}
          </Button>
        ))}
      </div>
      {document && document.sections.length > 0 ? (
        <div role="group" aria-label={t('sectionsLabel')} className="flex flex-wrap gap-1">
          {document.sections.map((section) => (
            <SectionCommentBadge
              key={section.key}
              title={section.title}
              count={sectionCounts.get(section.key) ?? 0}
              selected={filter === 'section' && sectionKey === section.key}
              onSelect={() => {
                setSectionKey(section.key);
                setFilter('section');
              }}
            />
          ))}
        </div>
      ) : null}
      {body}
      {query.hasNextPage ? (
        <Button
          variant="secondary"
          size="sm"
          disabled={query.isFetchingNextPage}
          onClick={() => {
            void query.fetchNextPage();
          }}
        >
          {t('loadMore')}
        </Button>
      ) : null}
      <DeleteCommentDialog
        comment={deleting}
        onClose={() => {
          setDeleting(null);
        }}
        onChanged={(outcome) => {
          if (outcome === 'removed') setAnnouncement(t('removed'));
          refresh();
        }}
      />
      <ModerationDialog
        comment={moderating}
        onClose={() => {
          setModerating(null);
        }}
        onChanged={(outcome) => {
          if (outcome === 'removed') setAnnouncement(t('removed'));
          refresh();
        }}
      />
    </section>
  );
}
