'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  toast,
} from '@contrataflow/ui';
import { PROCESS_EXPORT_MAX_ROWS, PROCESS_EXPORT_MESSAGES } from '@contrataflow/validation';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import type { ReactNode, RefObject } from 'react';

import { exceedsExportLimit, exportFailureMessage } from './saved-views-model';
import type { ExportFailure } from './saved-views-model';
import { useCsvDownload } from './use-csv-download';

/*
 * `ExportCsvDialog` (US-003 · fluxo principal 6–10, FA-06..FA-09): mostra o total da consulta atual
 * (`meta.totalItems`), as colunas do arquivo e, acima de 10.000, o aviso para refinar os filtros
 * (botão desabilitado). Durante a exportação mostra progresso indeterminado com "Cancelar", que
 * aborta o fetch. 422 `EXPORT_TOO_LARGE` usa o total devolvido pela API; 429 respeita o
 * `Retry-After`; conexão interrompida descarta o arquivo parcial. Ao concluir, toast `aria-live`.
 */

export interface ExportColumn {
  readonly id: string;
  readonly label: string;
}

export interface ExportCsvDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Total da consulta atual; `undefined` enquanto a lista está sendo (re)consultada. */
  readonly total: number | undefined;
  readonly columns: readonly ExportColumn[];
  /** Query de PRC-34 no momento do envio (filtros, ordenação, colunas e visão de origem). */
  readonly buildQuery: () => Record<string, string>;
  readonly returnFocusRef?: RefObject<HTMLElement | null> | undefined;
}

export function ExportCsvDialog({
  open,
  onOpenChange,
  total,
  columns,
  buildQuery,
  returnFocusRef,
}: ExportCsvDialogProps) {
  const t = useTranslations('processList.export');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel={t('close')}
        onCloseAutoFocus={(event) => {
          if (returnFocusRef?.current) {
            event.preventDefault();
            returnFocusRef.current.focus();
          }
        }}
      >
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
        <ExportBody
          total={total}
          columns={columns}
          buildQuery={buildQuery}
          onClose={() => {
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function ExportBody({
  total,
  columns,
  buildQuery,
  onClose,
}: {
  readonly total: number | undefined;
  readonly columns: readonly ExportColumn[];
  readonly buildQuery: () => Record<string, string>;
  readonly onClose: () => void;
}) {
  const t = useTranslations('processList.export');
  const tErrors = useTranslations('processList.views');
  const download = useCsvDownload({
    onDone: ({ rows }) => {
      toast({ title: t('done', { count: rows }), tone: 'success' });
      onClose();
    },
  });
  const { state } = download;
  const running = state.status === 'running';
  const failure = state.status === 'error' ? state.failure : null;
  const cooldown = useCooldown(failure, state.status === 'error' ? state.failedAt : 0);

  const overLimit = total !== undefined && exceedsExportLimit(total);
  const blocked =
    overLimit || failure?.kind === 'tooLarge' || failure?.kind === 'forbidden' || cooldown > 0;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!running && !blocked) void download.start(buildQuery());
      }}
    >
      <p className="text-sm font-medium" role="status">
        {total === undefined ? t('totalLoading') : t('total', { count: total })}
      </p>

      <div>
        <h3 className="text-sm font-medium">{t('columns')}</h3>
        <ul aria-label={t('columns')} className="mt-1 flex flex-wrap gap-1">
          {columns.map((column) => (
            <li key={column.id} className="rounded-full bg-muted px-2 py-0.5 text-xs">
              {column.label}
            </li>
          ))}
        </ul>
      </div>

      {overLimit && failure === null ? (
        <Alert tone="warning" title={PROCESS_EXPORT_MESSAGES.tooLarge(total)}>
          <p>{t('tooLargeHint')}</p>
        </Alert>
      ) : null}

      {failure !== null ? (
        <FailureAlert
          failure={failure}
          cooldown={cooldown}
          unavailableText={tErrors('unavailable')}
        >
          {failure.kind === 'tooLarge' ? <p>{t('tooLargeHint')}</p> : null}
        </FailureAlert>
      ) : null}

      {running ? (
        <div className="flex flex-col gap-2">
          <div
            role="progressbar"
            aria-label={t('progress')}
            className="h-1.5 w-full animate-pulse rounded bg-primary/50"
          />
          <p className="text-xs text-muted-foreground">{t('progress')}</p>
        </div>
      ) : null}

      <DialogFooter>
        {running ? (
          <Button type="button" variant="secondary" onClick={download.cancel}>
            {t('cancelExport')}
          </Button>
        ) : (
          <>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('close')}
            </Button>
            <Button type="submit" disabled={blocked || total === undefined}>
              {failure !== null && failure.kind !== 'tooLarge' ? t('retry') : t('confirm')}
            </Button>
          </>
        )}
      </DialogFooter>
    </form>
  );
}

/** Segundos restantes do `Retry-After` de um 429 (0 = livre), contados desde a falha. */
function useCooldown(failure: ExportFailure | null, failedAt: number): number {
  const seconds =
    failure?.kind === 'rateLimited' && failure.retryAfterSeconds !== null
      ? Math.min(failure.retryAfterSeconds, 120)
      : 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (seconds <= 0) return undefined;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [seconds, failedAt]);
  return Math.max(0, seconds - Math.floor(Math.max(0, now - failedAt) / 1000));
}

function FailureAlert({
  failure,
  cooldown,
  unavailableText,
  children,
}: {
  readonly failure: ExportFailure;
  readonly cooldown: number;
  readonly unavailableText: string;
  readonly children?: ReactNode;
}) {
  const t = useTranslations('processList.export');
  const format = useFormatter();
  const message =
    failure.kind === 'tooLarge' && failure.total === null
      ? t('tooLargeUnknown', { max: format.number(PROCESS_EXPORT_MAX_ROWS) })
      : (exportFailureMessage(failure) ?? unavailableText);
  const tone = failure.kind === 'rateLimited' ? 'info' : 'error';
  const correlationId =
    failure.kind === 'unavailable' || failure.kind === 'unexpected' ? failure.correlationId : null;
  return (
    <Alert tone={tone} title={message}>
      {children}
      {failure.kind === 'rateLimited' && cooldown > 0 ? (
        <p>{t('retryAfter', { seconds: cooldown })}</p>
      ) : null}
      {correlationId !== null ? <p>{t('code', { correlationId })}</p> : null}
    </Alert>
  );
}
