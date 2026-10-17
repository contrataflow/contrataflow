'use client';

import { Alert, Button, Skeleton, toast } from '@contrataflow/ui';
import type { AuditExportFormat, AuditLogDto } from '@contrataflow/validation';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { usePermission } from '@/lib/permissions/use-permission';
import { useShellSession } from '@/lib/session/session-context';

import { AuditDetailPanel } from './audit-detail-panel';
import type { AuditQuickFilter } from './audit-detail-panel';
import { AuditExportDialog } from './audit-export-dialog';
import { AuditFiltersPanel } from './audit-filters-panel';
import {
  actorOptions,
  classifyAuditError,
  defaultAuditFilters,
  saveFile,
  validateAuditFilters,
} from './audit-log-model';
import type { AuditFilterField, AuditFilterInput, AuditQuery } from './audit-log-model';
import {
  AUDIT_LOGS_STALE_TIME_MS,
  auditLogKeys,
  exportAuditLogs,
  fetchAuditLogs,
} from './audit-logs.api';
import { AuditResultsTable } from './audit-results-table';

/**
 * Exportação pendente durante o step-up de MFA (FA-04): o 403 `MFA_REQUIRED` leva ao step-up
 * global e, na volta a `/auditoria`, a aba repete a exportação com os mesmos filtros e formato.
 */
const PENDING_EXPORT_KEY = 'cf.audit.pendingExport';

interface PendingExport {
  readonly tenantId: string;
  readonly query: AuditQuery;
  readonly format: AuditExportFormat;
}

function readPendingExport(tenantId: string): PendingExport | null {
  try {
    // Sem remover aqui: a exportação repetida regrava ou limpa a pendência ao concluir.
    const raw = sessionStorage.getItem(PENDING_EXPORT_KEY);
    const parsed = raw === null ? null : (JSON.parse(raw) as PendingExport);
    return parsed?.tenantId === tenantId ? parsed : null;
  } catch {
    return null;
  }
}

function writePendingExport(pending: PendingExport | null): void {
  try {
    if (pending === null) sessionStorage.removeItem(PENDING_EXPORT_KEY);
    else sessionStorage.setItem(PENDING_EXPORT_KEY, JSON.stringify(pending));
  } catch {
    // Armazenamento indisponível: o usuário repete a exportação manualmente.
  }
}

/** Painel de filtros a partir de uma query aplicada (exportação retomada após o step-up). */
function inputOfQuery(base: AuditFilterInput, query: AuditQuery): AuditFilterInput {
  return {
    ...base,
    actions: query.action?.split(',') ?? [],
    category: query.category ?? '',
    result: query.result ?? '',
    actorUserId: query.actorUserId ?? '',
    entityType: query.entityType ?? '',
    entityId: query.entityId ?? '',
    processId: query.processId ?? '',
  };
}

/**
 * Aba "Registros" de SCR-037 (US-075): `AuditFiltersPanel` + `AuditResultsTable` (AUD-01 por
 * cursor) + `AuditDetailPanel` (AUD-02) + `ExportDialog` (AUD-03, só com `AUDIT_EXPORT`). Período
 * padrão: últimos 7 dias. Estados: skeleton, vazio (FA-01), erro com "Tentar novamente" e o
 * `correlationId`, carregando mais. O botão "Exportar" usa os filtros da última pesquisa.
 */
export function AuditRecordsTab() {
  const t = useTranslations('audit.records');
  const session = useShellSession();
  const tenantId = session.activeTenant.id;
  const timeZone = session.activeTenant.timezone;
  const canExport = usePermission('AUDIT_EXPORT').allowed;
  const messages = useMemo(
    () => ({ required: t('filters.required'), invalidId: t('filters.invalidId') }),
    [t],
  );

  const [initial] = useState(() => defaultAuditFilters(new Date(), timeZone));
  // Volta do step-up (FA-04): os filtros da exportação pendente substituem o padrão.
  const [pending] = useState(() => readPendingExport(tenantId));
  const [input, setInput] = useState<AuditFilterInput>(() =>
    pending === null ? initial : inputOfQuery(initial, pending.query),
  );
  const [applied, setApplied] = useState<AuditQuery | null>(() => {
    if (pending !== null) return pending.query;
    const validation = validateAuditFilters(initial, timeZone, messages);
    return validation.ok ? validation.query : null;
  });
  const [errors, setErrors] = useState<Partial<Record<AuditFilterField, string>>>({});
  const [selected, setSelected] = useState<AuditLogDto | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [knownActors, setKnownActors] = useState<readonly AuditLogDto[]>([]);
  /** O painel mudou depois da última pesquisa: o 422 da API deixa de valer para o campo. */
  const [inputDirty, setInputDirty] = useState(false);
  const periodRef = useRef<HTMLInputElement | null>(null);

  const feed = useInfiniteQuery({
    queryKey: auditLogKeys.list(tenantId, applied ?? {}),
    queryFn: async ({ pageParam, signal }) => {
      try {
        const page = await fetchAuditLogs(applied ?? {}, pageParam, signal);
        setKnownActors((known) => [...known, ...page.items]);
        return page;
      } catch (error) {
        // 422 sobre o período (V-01/V-02): foca o seletor de datas.
        if (classifyAuditError(error).kind === 'validation') {
          queueMicrotask(() => periodRef.current?.focus());
        }
        throw error;
      }
    },
    enabled: applied !== null,
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    staleTime: AUDIT_LOGS_STALE_TIME_MS,
    throwOnError: false,
    retry: false,
  });
  const records = useMemo(() => feed.data?.pages.flatMap((page) => page.items) ?? [], [feed.data]);
  const actors = useMemo(
    () => actorOptions(knownActors, input.actorUserId),
    [knownActors, input.actorUserId],
  );
  const feedFailure = feed.error === null ? null : classifyAuditError(feed.error);
  // Erros por campo: os da validação local e, depois da pesquisa, o 422 da API sobre o período.
  const fieldErrors =
    feedFailure?.kind === 'validation' && Object.keys(errors).length === 0 && !inputDirty
      ? { to: feedFailure.message }
      : errors;

  // 422 da API sobre o período (V-01/V-02): mostra no campo e foca o seletor de datas.
  const exporter = useMutation({
    mutationFn: ({ query, format }: { query: AuditQuery; format: AuditExportFormat }) =>
      exportAuditLogs(query, format),
    onSuccess: (file) => {
      writePendingExport(null);
      saveFile(file.blob, file.fileName);
      setExportOpen(false);
      toast({ title: t('export.done', { count: file.rowCount }), tone: 'success' });
    },
    onError: (error) => {
      // FA-04: só o MFA ausente mantém a exportação pendente para depois do step-up.
      if (!(isApiError(error) && error.code === 'MFA_REQUIRED')) writePendingExport(null);
    },
  });
  const exportFailure = exporter.error === null ? null : classifyAuditError(exporter.error);

  const runExport = useCallback(
    (query: AuditQuery, format: AuditExportFormat) => {
      writePendingExport({ tenantId, query, format });
      exporter.mutate({ query, format });
    },
    [exporter, tenantId],
  );

  // Volta do step-up (FA-04): repete a exportação pendente com os mesmos filtros e formato.
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current || pending === null) return;
    resumed.current = true;
    runExport(pending.query, pending.format);
  }, [pending, runExport]);

  const search = () => {
    setNotice(null);
    const validation = validateAuditFilters(input, timeZone, messages);
    if (!validation.ok) {
      setErrors(validation.errors);
      if (validation.errors.from !== undefined || validation.errors.to !== undefined) {
        periodRef.current?.focus();
      }
      return;
    }
    setErrors({});
    setInputDirty(false);
    setApplied(validation.query);
    if (JSON.stringify(validation.query) === JSON.stringify(applied)) void feed.refetch();
  };

  const applyQuickFilter = (filter: AuditQuickFilter) => {
    const next: AuditFilterInput =
      filter.kind === 'actor'
        ? { ...input, actorUserId: filter.id }
        : filter.kind === 'process'
          ? { ...input, processId: filter.id }
          : { ...input, entityType: filter.type, entityId: filter.id };
    setSelected(null);
    setInput(next);
    const validation = validateAuditFilters(next, timeZone, messages);
    if (validation.ok) {
      setErrors({});
      setApplied(validation.query);
    }
  };

  const onNotFound = useCallback(() => {
    setSelected(null);
    setNotice(t('detail.notFound'));
  }, [t]);

  let body: ReactNode = null;
  if (applied !== null && feed.isPending) {
    body = (
      <div role="status" className="flex flex-col gap-2">
        <span className="sr-only">{t('table.loading')}</span>
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  } else if (feedFailure !== null && feedFailure.kind !== 'validation' && records.length === 0) {
    body = (
      <Alert
        tone="error"
        title={
          feedFailure.kind === 'forbidden'
            ? t('errors.forbidden')
            : feedFailure.kind === 'mfa'
              ? t('errors.mfa')
              : t('errors.unavailable')
        }
      >
        {feedFailure.kind === 'unavailable' || feedFailure.kind === 'unexpected' ? (
          <p className="text-sm">
            {t('errors.code', { correlationId: feedFailure.correlationId ?? '—' })}
          </p>
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          className="mt-2"
          onClick={() => {
            void feed.refetch();
          }}
        >
          {t('errors.retry')}
        </Button>
      </Alert>
    );
  } else if (feed.data && records.length === 0) {
    body = (
      <div className="rounded-card border border-dashed border-border p-6 text-center">
        <p className="font-medium">{t('table.empty')}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t('table.emptyHint')}</p>
      </div>
    );
  } else if (records.length > 0) {
    body = (
      <AuditResultsTable
        records={records}
        timeZone={timeZone}
        onOpen={setSelected}
        hasMore={feed.hasNextPage}
        loadingMore={feed.isFetchingNextPage}
        onLoadMore={() => {
          void feed.fetchNextPage();
        }}
        busy={feed.isFetching}
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm text-muted-foreground">{t('description')}</p>
        {canExport ? (
          <Button
            variant="secondary"
            disabled={applied === null || exporter.isPending}
            onClick={() => {
              exporter.reset();
              setExportOpen(true);
            }}
          >
            {exporter.isPending ? t('export.exporting') : t('export.button')}
          </Button>
        ) : null}
      </div>
      <AuditFiltersPanel
        value={input}
        onChange={(next) => {
          setInput(next);
          setInputDirty(true);
          if (Object.keys(errors).length > 0) setErrors({});
        }}
        onSearch={search}
        onClear={() => {
          setInput(initial);
          setErrors({});
        }}
        timeZone={timeZone}
        errors={fieldErrors}
        actors={actors}
        pending={feed.isFetching && !feed.isFetchingNextPage}
        periodRef={periodRef}
      />
      {notice ? <Alert tone="info" title={notice} /> : null}
      {body}
      <AuditDetailPanel
        record={selected}
        timeZone={timeZone}
        onClose={() => {
          setSelected(null);
        }}
        onNotFound={onNotFound}
        onFilter={applyQuickFilter}
      />
      {canExport ? (
        <AuditExportDialog
          open={exportOpen}
          onOpenChange={setExportOpen}
          pending={exporter.isPending}
          failure={exportFailure?.kind === 'mfa' ? null : exportFailure}
          onExport={(format) => {
            if (applied !== null) runExport(applied, format);
          }}
        />
      ) : null}
    </div>
  );
}
