'use client';

import { renderTimelineEntry } from '@contrataflow/types';
import type { TimelineGroup } from '@contrataflow/types';
import { Alert, Button, EmptyState, Skeleton, cx } from '@contrataflow/ui';
import type { TimelineEntryDto } from '@contrataflow/validation';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useNow, useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { Icon } from '@/components/shell/icons';
import type { IconName } from '@/components/shell/icons';
import { ApiError } from '@/lib/api/api-error';
import { useShellSession } from '@/lib/session/session-context';

import { TimelineFilterBar } from './timeline-filter-bar';
import {
  EMPTY_TIMELINE_FILTERS,
  entryGroup,
  groupTimelineByDay,
  hasActiveFilters,
  mergeActorOptions,
  timelineQueryOf,
} from './timeline-model';
import type { ActorOption, TimelineDay, TimelineFilters } from './timeline-model';
import { fetchTimeline, timelineKeys } from './timeline.api';

/** Ícone por grupo (RN-TML-12). */
const GROUP_ICONS: Readonly<Record<TimelineGroup, IconName>> = {
  PROCESSO: 'folder',
  TRAMITACAO: 'truck',
  DOCUMENTOS: 'archive',
  APROVACOES: 'stamp',
  COMENTARIOS: 'message',
};

/** Marcador colorido por grupo (o texto da entrada diz o que aconteceu — nunca só a cor). */
const GROUP_TONES: Readonly<Record<TimelineGroup, string>> = {
  PROCESSO: 'bg-primary-soft text-primary-soft-foreground',
  TRAMITACAO: 'bg-warning-soft text-warning-soft-foreground',
  DOCUMENTOS: 'bg-success-soft text-success-soft-foreground',
  APROVACOES: 'bg-approval-soft text-approval-soft-foreground',
  COMENTARIOS: 'bg-neutral-soft text-neutral-soft-foreground',
};

function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', { timeStyle: 'short', timeZone }).format(new Date(iso));
}

/** Data completa de um dia local (`YYYY-MM-DD`), sem depender do fuso do navegador. */
function formatDay(date: string): string {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeZone: 'UTC' }).format(
    new Date(`${date}T12:00:00Z`),
  );
}

/**
 * `TimelineEntryItem`: marcador colorido com o ícone do grupo sobre o trilho vertical, mensagem do
 * dicionário com ator e ação (RN-TML-14), horário e unidade.
 */
export function TimelineEntryItem({
  entry,
  timeZone,
}: {
  readonly entry: TimelineEntryDto;
  readonly timeZone: string;
}) {
  const t = useTranslations('timeline');
  const { message, detail } = renderTimelineEntry(entry);
  const time = formatTime(entry.occurredAt, timeZone);
  const group = entryGroup(entry);
  return (
    <li
      className="relative flex min-w-0 gap-3 pb-5 before:absolute before:top-9 before:bottom-1 before:left-4 before:w-px before:bg-border last:pb-0 last:before:hidden"
      aria-label={t('entryLabel', { message, time })}
    >
      <span
        aria-hidden="true"
        className={cx(
          'relative flex size-8 shrink-0 items-center justify-center rounded-full ring-4 ring-surface',
          GROUP_TONES[group],
        )}
      >
        <Icon name={GROUP_ICONS[group]} />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5 pt-1">
        <p className="text-sm break-words text-foreground">{message}</p>
        {detail ? <p className="text-sm break-words text-muted-foreground">“{detail}”</p> : null}
        <p className="text-xs text-muted-foreground">
          <time dateTime={entry.occurredAt}>{time}</time>
          {entry.actorDepartmentName ? ` · ${entry.actorDepartmentName}` : null}
        </p>
      </div>
    </li>
  );
}

/** `TimelineDayGroup`: cabeçalho `<h3>` do dia ("Hoje", "Ontem" ou data completa — RN-TML-15). */
export function TimelineDayGroup({
  day,
  timeZone,
}: {
  readonly day: TimelineDay;
  readonly timeZone: string;
}) {
  const t = useTranslations('timeline');
  const label =
    day.relative === 'today'
      ? t('today')
      : day.relative === 'yesterday'
        ? t('yesterday')
        : formatDay(day.date);
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-label font-semibold text-muted-foreground uppercase">{label}</h3>
      <ol className="flex flex-col">
        {day.entries.map((entry) => (
          <TimelineEntryItem key={entry.id} entry={entry} timeZone={timeZone} />
        ))}
      </ol>
    </section>
  );
}

/** Mensagem por falha ("Casos de erro" da US-060): 429, 503 (banco ou rede) e inesperado. */
function errorMessageKey(error: unknown): 'unavailable' | 'rateLimited' | 'unexpected' {
  if (error instanceof ApiError && error.status === 429) return 'rateLimited';
  if (error instanceof ApiError && error.status === 503) return 'unavailable';
  return 'unexpected';
}

/** Erro de carga com "Tentar novamente" (mantém os filtros aplicados). */
function FeedError({ error, onRetry }: { readonly error: unknown; readonly onRetry: () => void }) {
  const t = useTranslations('timeline.errors');
  const key = errorMessageKey(error);
  const correlationId = error instanceof ApiError ? (error.correlationId ?? '—') : '—';
  return (
    <Alert tone="error" title={t(key, { correlationId })}>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={onRetry}>
          {t('retry')}
        </Button>
        {key === 'unexpected' && correlationId !== '—' ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void navigator.clipboard.writeText(correlationId);
            }}
          >
            {t('copy')}
          </Button>
        ) : null}
      </div>
    </Alert>
  );
}

/** Erro de cursor (V-02): 422 em `cursor` — a lista recomeça do início. */
function isCursorError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 422 &&
    error.errors.some((item) => item.field === 'cursor')
  );
}

/**
 * Aba "Timeline" de SCR-006 (US-060): `TimelineFilterBar` + `TimelineFeed` com scroll infinito
 * (`useInfiniteQuery` sobre PRC-12 — sentinela observada, com "Carregar mais" como alternativa
 * acessível), agrupada por dia no fuso do tenant. Estados: skeleton, vazio, vazio por filtro
 * ("Limpar filtros"), erro com "Tentar novamente" e carregando mais. 404 (processo deixou de ser
 * visível) volta à lista de processos.
 */
export function TimelineFeed({ processId }: { readonly processId: string }) {
  const t = useTranslations('timeline');
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = useShellSession();
  const tenantId = session.activeTenant.id;
  const timeZone = session.activeTenant.timezone;
  const now = useNow({ updateInterval: 60_000 });
  const [filters, setFilters] = useState<TimelineFilters>(EMPTY_TIMELINE_FILTERS);
  const [actors, setActors] = useState<readonly ActorOption[]>([]);
  const [cursorReset, setCursorReset] = useState(false);
  const [filterBarKey, setFilterBarKey] = useState(0);
  const sentinel = useRef<HTMLDivElement | null>(null);

  const query = useMemo(() => timelineQueryOf(filters, timeZone), [filters, timeZone]);
  const queryKey = timelineKeys.list(tenantId, processId, query);
  const feed = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam, signal }) => {
      try {
        const page = await fetchTimeline(processId, { query, cursor: pageParam }, signal);
        // RN-TML-11: os autores oferecidos são os já vistos na timeline carregada.
        setActors((known) => mergeActorOptions(known, page.items));
        return page;
      } catch (error) {
        if (pageParam !== null && isCursorError(error)) {
          // V-02: cursor inválido/expirado → recomeça do início, avisando.
          setCursorReset(true);
          queueMicrotask(() => {
            void queryClient.resetQueries({ queryKey });
          });
        }
        throw error;
      }
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    throwOnError: false,
    retry: false,
  });

  const entries = useMemo(() => feed.data?.pages.flatMap((page) => page.items) ?? [], [feed.data]);
  const days = useMemo(() => groupTimelineByDay(entries, timeZone, now), [entries, timeZone, now]);

  const { error, hasNextPage, isFetchingNextPage, fetchNextPage } = feed;

  useEffect(() => {
    if (error instanceof ApiError && error.status === 404) router.push('/processos');
  }, [error, router]);

  useEffect(() => {
    const target = sentinel.current;
    if (!target || !hasNextPage || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((observed) => {
      if (observed.some((item) => item.isIntersecting) && !isFetchingNextPage) {
        void fetchNextPage();
      }
    });
    observer.observe(target);
    return () => {
      observer.disconnect();
    };
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const clearFilters = () => {
    setFilters(EMPTY_TIMELINE_FILTERS);
    setFilterBarKey((current) => current + 1);
  };

  let body: ReactNode;
  if (feed.isPending) {
    body = (
      <div role="status" aria-label={t('loading')} className="flex flex-col gap-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  } else if (feed.isError && entries.length === 0) {
    body = <FeedError error={feed.error} onRetry={() => void feed.refetch()} />;
  } else if (entries.length === 0) {
    body = hasActiveFilters(filters) ? (
      <EmptyState
        title={t('emptyFiltered')}
        action={
          <Button size="sm" variant="secondary" onClick={clearFilters}>
            {t('filters.clear')}
          </Button>
        }
      />
    ) : (
      <EmptyState icon={<Icon name="clock" />} title={t('empty')} description={t('emptyHint')} />
    );
  } else {
    body = (
      <div
        className="flex flex-col gap-6 rounded-card border border-border bg-surface p-5 shadow-card"
        aria-label={t('listLabel')}
        role="region"
      >
        {feed.isError && !isCursorError(feed.error) ? (
          <FeedError error={feed.error} onRetry={() => void feed.fetchNextPage()} />
        ) : null}
        {days.map((day) => (
          <TimelineDayGroup key={day.date} day={day} timeZone={timeZone} />
        ))}
        <div ref={sentinel} />
        {feed.isFetchingNextPage ? (
          <p role="status" className="text-center text-sm text-muted-foreground">
            {t('loadingMore')}
          </p>
        ) : feed.hasNextPage ? (
          <Button
            variant="secondary"
            className="self-center"
            onClick={() => void feed.fetchNextPage()}
          >
            {t('loadMore')}
          </Button>
        ) : (
          <p className="text-center text-xs text-muted-foreground">{t('end')}</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <TimelineFilterBar
        key={filterBarKey}
        filters={filters}
        actors={actors}
        onChange={(next) => {
          setCursorReset(false);
          setFilters(next);
        }}
      />
      {cursorReset ? <Alert tone="info" title={t('errors.cursor')} /> : null}
      {body}
    </div>
  );
}
