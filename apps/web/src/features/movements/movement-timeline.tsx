'use client';

import { Alert, Button, EmptyState, Skeleton, cx } from '@contrataflow/ui';
import type { MovementAction, MovementItemDto } from '@contrataflow/validation';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { Icon } from '@/components/shell/icons';
import type { IconName } from '@/components/shell/icons';
import { ApiError } from '@/lib/api/api-error';
import { useShellSession } from '@/lib/session/session-context';

import { MovementFilterBar } from './movement-filter-bar';
import {
  EMPTY_FILTER_OPTIONS,
  EMPTY_MOVEMENT_FILTERS,
  hasActiveFilters,
  mergeFilterOptions,
  movementQueryOf,
  statusChanged,
} from './movements-model';
import type { MovementFilterOptions, MovementFilters } from './movements-model';
import { MOVEMENTS_STALE_TIME_MS, fetchMovements, movementKeys } from './movements.api';

/** Ícone por ação (`MovementRow` — fluxo principal 5). */
const ACTION_ICONS: Readonly<Record<MovementAction, IconName>> = {
  CREATE: 'plus',
  FORWARD: 'truck',
  RETURN: 'inbox',
  CLAIM: 'user',
  ASSIGN: 'user',
  APPROVE: 'stamp',
  REJECT: 'close',
  COMPLETE: 'check',
  CANCEL: 'close',
  SUSPEND: 'alert',
  RESUME: 'clock',
};

function formatDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(iso));
}

function formatDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone }).format(new Date(iso));
}

type PartyRef = MovementItemDto['fromDepartment'];

/** Nome da unidade/usuário com o selo "(inativo)" (FA-05); sem nome, "Não identificado". */
function PartyName({ party }: { readonly party: NonNullable<PartyRef> }) {
  const t = useTranslations('movements.row');
  return (
    <>
      {party.name ?? t('unknown')}
      {party.isActive ? null : (
        <span className="ml-1 text-xs text-muted-foreground">{t('inactive')}</span>
      )}
    </>
  );
}

/** "Etapa · Unidade" de um lado da tramitação (o que houver). */
function Side({
  stage,
  department,
}: {
  readonly stage: MovementItemDto['fromStage'];
  readonly department: PartyRef;
}) {
  const t = useTranslations('movements.row');
  const stageName = stage === null ? null : (stage.name ?? t('unknown'));
  if (department === null) return <>{stageName}</>;
  if (stageName === null) return <PartyName party={department} />;
  return (
    <>
      {stageName} · <PartyName party={department} />
    </>
  );
}

/** `ApprovalLinkBadge` (FA-03): selo "Decisão de aprovação" e o link para a aprovação (US-052). */
export function ApprovalLinkBadge({ item }: { readonly item: MovementItemDto }) {
  const t = useTranslations('movements.row');
  const tDecision = useTranslations('movements.decisions');
  if (item.approvalId === null) return null;
  const summary = item.approvalSummary;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1.5 rounded-control bg-muted px-2 py-0.5 text-xs font-medium whitespace-nowrap">
        <Icon name="stamp" className="size-3.5" />
        {t('approvalBadge')}
      </span>
      {summary ? (
        <span className="text-sm text-muted-foreground">
          {t('approvalTitle', {
            title: summary.title,
            decision: tDecision(summary.decision ?? 'PENDING'),
          })}
        </span>
      ) : null}
      <Link href={`/aprovacoes/${item.approvalId}`} className="text-sm text-primary underline">
        {t('approvalLink')}
      </Link>
    </div>
  );
}

/** `MovementRow`: ícone da ação, de → para, ator, comentário, prazo, documentos e (FA-02) IP. */
/** Marcador colorido por ação: avanço em azul, devolução em âmbar, decisão e encerramento. */
const ACTION_TONES: Readonly<Record<MovementAction, string>> = {
  CREATE: 'bg-neutral-soft text-neutral-soft-foreground',
  FORWARD: 'bg-primary-soft text-primary-soft-foreground',
  RETURN: 'bg-warning-soft text-warning-soft-foreground',
  CLAIM: 'bg-primary-soft text-primary-soft-foreground',
  ASSIGN: 'bg-primary-soft text-primary-soft-foreground',
  APPROVE: 'bg-success-soft text-success-soft-foreground',
  REJECT: 'bg-destructive-soft text-destructive-soft-foreground',
  COMPLETE: 'bg-success-soft text-success-soft-foreground',
  CANCEL: 'bg-destructive-soft text-destructive-soft-foreground',
  SUSPEND: 'bg-warning-soft text-warning-soft-foreground',
  RESUME: 'bg-approval-soft text-approval-soft-foreground',
};

export function MovementRow({
  item,
  processId,
  timeZone,
  canViewIp,
}: {
  readonly item: MovementItemDto;
  readonly processId: string;
  readonly timeZone: string;
  readonly canViewIp: boolean;
}) {
  const t = useTranslations('movements.row');
  const tActions = useTranslations('movements.actions');
  const tStatus = useTranslations('movements.statuses');
  const action = tActions(item.action);
  const when = formatDateTime(item.occurredAt, timeZone);
  const hasFrom = item.fromStage !== null || item.fromDepartment !== null;
  const hasTo = item.toStage !== null || item.toDepartment !== null;
  const actorName = item.actor.type === 'SYSTEM' ? t('system') : (item.actor.name ?? t('unknown'));
  return (
    <li
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- cada item focável (lista navegável por teclado — US-054)
      tabIndex={0}
      aria-label={t('label', { action, sequence: item.sequence, date: when })}
      className="relative flex min-w-0 gap-3 rounded-control pb-5 before:absolute before:top-9 before:bottom-1 before:left-4 before:w-px before:bg-border last:pb-0 last:before:hidden focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none"
    >
      <span
        aria-hidden="true"
        className={cx(
          'relative flex size-8 shrink-0 items-center justify-center rounded-full ring-4 ring-surface',
          ACTION_TONES[item.action],
        )}
      >
        <Icon name={ACTION_ICONS[item.action]} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1 pt-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <p className="text-sm font-semibold text-brand-ink">{action}</p>
          <time dateTime={item.occurredAt} className="text-xs text-muted-foreground">
            {when}
          </time>
        </div>
        {hasFrom || hasTo || item.toUser !== null ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-sm break-words">
            {hasFrom ? (
              <>
                <dt className="text-muted-foreground">{t('from')}</dt>
                <dd className="min-w-0">
                  <Side stage={item.fromStage} department={item.fromDepartment} />
                </dd>
              </>
            ) : null}
            {hasTo ? (
              <>
                <dt className="text-muted-foreground">{t('to')}</dt>
                <dd className="min-w-0">
                  <Side stage={item.toStage} department={item.toDepartment} />
                  {item.toUser ? (
                    <span className="block text-muted-foreground">
                      {t('responsible')} <PartyName party={item.toUser} />
                    </span>
                  ) : null}
                </dd>
              </>
            ) : null}
          </dl>
        ) : null}
        {statusChanged(item) && item.statusTo !== null ? (
          <p className="text-xs text-muted-foreground">
            {item.statusFrom === null
              ? t('statusTo', { to: tStatus(item.statusTo) })
              : t('status', { from: tStatus(item.statusFrom), to: tStatus(item.statusTo) })}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {item.actor.departmentName
            ? t('actorWithDepartment', { name: actorName, department: item.actor.departmentName })
            : t('actor', { name: actorName })}
        </p>
        {item.comment ? (
          <p className="text-sm break-words whitespace-pre-line">“{item.comment}”</p>
        ) : null}
        {item.dueAt ? (
          <p className="text-xs text-muted-foreground">
            {t('dueAt', { date: formatDate(item.dueAt, timeZone) })}
          </p>
        ) : null}
        {item.documents.length > 0 ? (
          <div className="flex flex-col gap-0.5">
            <p className="text-xs font-medium text-muted-foreground">{t('documents')}</p>
            <ul className="flex flex-col gap-0.5">
              {item.documents.map((document) => (
                <li key={`${document.documentId}-${document.documentVersionId ?? ''}`}>
                  <Link
                    href={`/processos/${processId}/documentos/${document.documentId}/versoes`}
                    className="text-sm text-primary underline"
                  >
                    {document.versionNumber === null
                      ? (document.code ?? document.title)
                      : t('documentVersion', {
                          title: document.code ?? document.title,
                          version: document.versionNumber,
                        })}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <ApprovalLinkBadge item={item} />
        {canViewIp ? (
          <p className="text-xs text-muted-foreground">
            {item.ip === null ? t('ipUnknown') : t('ip', { ip: item.ip })}
          </p>
        ) : null}
      </div>
    </li>
  );
}

type ErrorKey = 'unavailable' | 'rateLimited' | 'unexpected' | 'filters';

/** Mensagem por falha ("Casos de erro" da US-054). */
function errorMessageKey(error: unknown): ErrorKey {
  if (error instanceof ApiError && error.status === 422) return 'filters';
  if (error instanceof ApiError && error.status === 429) return 'rateLimited';
  if (error instanceof ApiError && error.status === 503) return 'unavailable';
  return 'unexpected';
}

/** Erro de carga com "Tentar novamente" (mantém os filtros aplicados). */
function FeedError({ error, onRetry }: { readonly error: unknown; readonly onRetry: () => void }) {
  const t = useTranslations('movements.errors');
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

/** Erro de cursor (V-04): 422 em `cursor` — a lista recomeça do início. */
function isCursorError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 422 &&
    error.errors.some((item) => item.field === 'cursor')
  );
}

/**
 * Aba "Tramitação" de SCR-006 (US-054): `MovementFilterBar` + `MovementTimeline` com scroll infinito
 * (`useInfiniteQuery` sobre PRC-11 — sentinela observada, com "Carregar mais" como alternativa
 * acessível), mais recente primeiro. Estados: skeleton, vazio, vazio por filtro ("Limpar filtros" —
 * FA-06), erro com "Tentar novamente" e carregando mais (`aria-live`). Sem `AUDIT_VIEW`
 * (`meta.canViewIp = false`), o IP não aparece (FA-02). 404 volta à lista de processos.
 */
export function MovementTimeline({ processId }: { readonly processId: string }) {
  const t = useTranslations('movements');
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = useShellSession();
  const tenantId = session.activeTenant.id;
  const timeZone = session.activeTenant.timezone;
  const [filters, setFilters] = useState<MovementFilters>(EMPTY_MOVEMENT_FILTERS);
  const [options, setOptions] = useState<MovementFilterOptions>(EMPTY_FILTER_OPTIONS);
  const [cursorReset, setCursorReset] = useState(false);
  const [filterBarKey, setFilterBarKey] = useState(0);
  const sentinel = useRef<HTMLDivElement | null>(null);

  const query = useMemo(() => movementQueryOf(filters, timeZone), [filters, timeZone]);
  const queryKey = movementKeys.list(tenantId, processId, query);
  const feed = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam, signal }) => {
      try {
        const page = await fetchMovements(processId, { query, cursor: pageParam }, signal);
        // As unidades e os atores oferecidos são os já vistos no histórico carregado.
        setOptions((known) => mergeFilterOptions(known, page.items));
        return page;
      } catch (error) {
        if (pageParam !== null && isCursorError(error)) {
          // V-04: cursor inválido/expirado → recomeça do início, avisando.
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
    staleTime: MOVEMENTS_STALE_TIME_MS,
    throwOnError: false,
    retry: false,
  });

  const items = useMemo(() => feed.data?.pages.flatMap((page) => page.items) ?? [], [feed.data]);
  const canViewIp = feed.data?.pages[0]?.canViewIp === true;
  const pageCount = feed.data?.pages.length ?? 0;

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
    setFilters(EMPTY_MOVEMENT_FILTERS);
    setFilterBarKey((current) => current + 1);
  };

  let body: ReactNode;
  if (feed.isPending) {
    body = (
      <div role="status" aria-label={t('loading')} className="flex flex-col gap-3">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  } else if (feed.isError && items.length === 0) {
    body = <FeedError error={feed.error} onRetry={() => void feed.refetch()} />;
  } else if (items.length === 0) {
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
      <EmptyState icon={<Icon name="truck" />} title={t('empty')} description={t('emptyHint')} />
    );
  } else {
    body = (
      <div className="flex flex-col gap-4 rounded-card border border-border bg-surface p-5 shadow-card">
        {feed.isError && !isCursorError(feed.error) ? (
          <FeedError error={feed.error} onRetry={() => void feed.fetchNextPage()} />
        ) : null}
        <ol aria-label={t('listLabel')} className="flex flex-col">
          {items.map((item) => (
            <MovementRow
              key={item.id}
              item={item}
              processId={processId}
              timeZone={timeZone}
              canViewIp={canViewIp}
            />
          ))}
        </ol>
        <p aria-live="polite" className="sr-only">
          {pageCount > 1 ? t('loadedMore', { count: items.length }) : ''}
        </p>
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
      <MovementFilterBar
        key={filterBarKey}
        filters={filters}
        options={options}
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
