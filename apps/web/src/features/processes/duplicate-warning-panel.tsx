'use client';

import { Alert, Button, buttonClassName } from '@contrataflow/ui';
import type { DuplicateCandidate } from '@contrataflow/validation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { forwardRef } from 'react';

import { formatDateTime } from '@/lib/i18n/format';

export interface DuplicateWarningPanelProps {
  readonly candidates: readonly DuplicateCandidate[];
  /** Fuso da instituição ativa, para a data de criação dos candidatos. */
  readonly timeZone: string;
  readonly pending: boolean;
  /** "Criar mesmo assim": reenvia com `confirmDuplicate: true` (FA-02). */
  readonly onCreateAnyway: () => void;
}

/**
 * `DuplicateWarningPanel` (FA-02 · RN-PROC-13): processos parecidos criados há pouco, com link para
 * cada um e a escolha entre abrir o existente ou "Criar mesmo assim". Os links levam ao processo
 * sem pedir confirmação de saída — o rascunho continua no navegador (`data-keep-draft`).
 */
export const DuplicateWarningPanel = forwardRef<HTMLDivElement, DuplicateWarningPanelProps>(
  function DuplicateWarningPanel({ candidates, timeZone, pending, onCreateAnyway }, ref) {
    const t = useTranslations('processes');
    return (
      <div ref={ref} tabIndex={-1} className="outline-none">
        <Alert tone="warning" title={t('duplicates.title')}>
          <p>{t('duplicates.description')}</p>
          {candidates.length > 0 ? (
            <ul aria-label={t('duplicates.listLabel')} className="mt-3 flex flex-col gap-3">
              {candidates.map((candidate) => {
                const code = candidate.code ?? t('duplicates.noNumber');
                return (
                  <li
                    key={candidate.id}
                    className="flex min-w-0 flex-col gap-1 rounded-control border border-border bg-surface p-3"
                  >
                    <Link
                      href={`/processos/${candidate.id}`}
                      data-keep-draft=""
                      className="font-semibold text-primary underline"
                    >
                      {code}
                    </Link>
                    <span className="break-words">{candidate.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {t('duplicates.meta', {
                        status: t(`statuses.${candidate.status}`),
                        name: candidate.createdBy.name,
                        date: formatDateTime(candidate.createdAt, timeZone),
                      })}
                    </span>
                    <Link
                      href={`/processos/${candidate.id}`}
                      data-keep-draft=""
                      aria-label={t('duplicates.openNamed', { code })}
                      className={buttonClassName({
                        variant: 'secondary',
                        size: 'sm',
                        className: 'mt-1 self-start',
                      })}
                    >
                      {t('duplicates.open')}
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-3"
            disabled={pending}
            onClick={onCreateAnyway}
          >
            {t('duplicates.createAnyway')}
          </Button>
        </Alert>
      </div>
    );
  },
);
