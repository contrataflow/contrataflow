'use client';

import { renderTimelineEntry } from '@contrataflow/types';
import type { TimelineGroup } from '@contrataflow/types';
import { Alert, Button, Skeleton } from '@contrataflow/ui';
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

function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', { timeStyle: 'short', timeZone }).format(new Date(iso));
}

/** Data completa de um dia local (`YYYY-MM-DD`), sem depender do fuso do navegador. */
function formatDay(date: string): string {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeZone: 'UTC' }).format(
    new Date(`${date}T12:00:00Z`),
  );
}

/** `TimelineEntryItem`: ícone do grupo, mensagem do dicionário (RN-TML-14), ator e horário. */
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
  return (
    <li className="flex min-w-0 gap-3 py-3" aria-label={t('entryLabel', { message, time })}>
      <span
        aria-hidden="true"
        className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
      >
        <Icon name={GROUP_ICONS[entryGroup(entry)]} />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-sm break-words">{message}</p>
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
    <section className="flex flex-col">
      <h3 className="border-b border-border pb-1 text-sm font-semibold capitalize">{label}</h3>
      <ol className="divide-y divide-border">
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
      <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-border p-8 text-center">
        <p className="font-medium">{t('emptyFiltered')}</p>
        <Button size="sm" variant="secondary" onClick={clearFilters}>
          {t('filters.clear')}
        </Button>
      </div>
    ) : (
      <div className="rounded-card border border-dashed border-border p-8 text-center">
        <p className="font-medium">{t('empty')}</p>
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-4" aria-label={t('listLabel')} role="region">
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
