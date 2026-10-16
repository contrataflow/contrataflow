'use client';

import { Skeleton, cx } from '@contrataflow/ui';
import type { ChecklistViolation } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId } from 'react';
import type { ReactNode } from 'react';

import { PanelError } from './panel-error';
import { splitViolations, useProcessChecklist } from './process-actions.api';

/** Ícone decorativo: a severidade sempre vem escrita ao lado (nunca só cor). */
function SeverityIcon({ blocking }: { readonly blocking: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={cx('mt-0.5 size-4 shrink-0', blocking ? 'text-destructive' : 'text-warning')}
      fill="currentColor"
    >
      {blocking ? (
        <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm3.2 9.1-1.1 1.1L8 9.1l-2.1 2.1-1.1-1.1L6.9 8 4.8 5.9l1.1-1.1L8 6.9l2.1-2.1 1.1 1.1L9.1 8l2.1 2.1Z" />
      ) : (
        <path d="M8 1.5 15 14H1L8 1.5Zm-.75 4.5v4h1.5V6h-1.5Zm0 5v1.5h1.5V11h-1.5Z" />
      )}
    </svg>
  );
}

function ViolationItem({ violation }: { readonly violation: ChecklistViolation }) {
  const t = useTranslations('processActions.checklist');
  const blocking = violation.severity === 'BLOCKING';
  return (
    <li
      className={cx(
        'flex gap-2 rounded-control border p-3 text-sm',
        blocking ? 'border-destructive/40 bg-destructive-soft' : 'border-warning/30',
      )}
    >
      <SeverityIcon blocking={blocking} />
      <div className="flex flex-col gap-0.5">
        <span className={cx('text-xs font-semibold uppercase', !blocking && 'font-medium')}>
          {t(blocking ? 'blocking' : 'warning')}
          <span className="sr-only">: {t(blocking ? 'blockingHint' : 'warningHint')}</span>
        </span>
        <span className={cx(blocking && 'font-medium')}>{violation.message}</span>
      </div>
    </li>
  );
}

export interface StageChecklistProps {
  readonly processId: string;
}

/**
 * `StageChecklist` (US-041 · PRC-09): pendências da etapa atual — bloqueantes em destaque, avisos
 * depois (RN-WF-25), com ícone + texto. Lista colapsável (`<details>`) para telas estreitas.
 */
export function StageChecklist({ processId }: StageChecklistProps) {
  const t = useTranslations('processActions.checklist');
  const headingId = useId();
  const query = useProcessChecklist(processId);

  let body: ReactNode;
  if (query.data === undefined && query.isPending) {
    body = (
      <div role="status" className="flex flex-col gap-2">
        <span className="sr-only">{t('loading')}</span>
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
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
    const { blocking, warnings } = splitViolations(query.data);
    body = (
      <details open className="group">
        <summary className="cursor-pointer text-sm font-medium text-muted-foreground">
          {t('summary', { count: query.data.length })}
        </summary>
        <ul className="mt-2 flex flex-col gap-2">
          {[...blocking, ...warnings].map((violation) => (
            <ViolationItem key={violation.ruleId} violation={violation} />
          ))}
        </ul>
      </details>
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
