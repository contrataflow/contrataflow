'use client';

import { Skeleton } from '@contrataflow/ui';
import type { ActionEntry } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId } from 'react';
import type { ReactNode } from 'react';

import { ActionButton } from './action-button';
import { PanelError } from './panel-error';
import { orderActions, useAvailableActions } from './process-actions.api';

export interface AvailableActionsPanelProps {
  readonly processId: string;
  readonly onAction?: ((entry: ActionEntry) => void) | undefined;
}

/**
 * `AvailableActionsPanel` (US-041 · PRC-08 — consumido pelo painel situacional SCR-006 da US-004):
 * botões habilitados na ordem da API (principal primeiro) e indisponíveis com o motivo. Estados:
 * skeleton na primeira carga, erro com "Tentar novamente" e sondagem silenciosa que mantém o painel
 * anterior numa falha pontual.
 */
export function AvailableActionsPanel({ processId, onAction }: AvailableActionsPanelProps) {
  const t = useTranslations('processActions.actions');
  const headingId = useId();
  const query = useAvailableActions(processId);

  let body: ReactNode;
  if (query.data === undefined && query.isPending) {
    body = (
      <div role="status" className="flex flex-wrap gap-2">
        <span className="sr-only">{t('loading')}</span>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-8 w-28" />
      </div>
    );
  } else if (query.data === undefined) {
    body = (
      <PanelError
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  } else if (query.data.length === 0) {
    body = <p className="text-sm text-muted-foreground">{t('empty')}</p>;
  } else {
    body = (
      <ul className="flex flex-wrap gap-2">
        {orderActions(query.data).map((entry) => (
          <li key={`${entry.action}:${entry.transitionKey ?? ''}`}>
            <ActionButton entry={entry} onSelect={onAction} />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-base font-semibold">
        {t('heading')}
      </h2>
      {body}
    </section>
  );
}
