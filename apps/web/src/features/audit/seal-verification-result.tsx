'use client';

import { Alert, Button, Skeleton } from '@contrataflow/ui';
import { AUDIT_SEAL_MESSAGES } from '@contrataflow/validation';
import type { AuditSealVerification } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import type { RefObject } from 'react';

import { stepUpHref } from '@/lib/api/error-policy';
import { formatDateTime } from '@/lib/i18n/format';

import type { VerifyFailure } from './seal-model';
import { SealStatusBadge } from './seal-status-badge';

export interface SealVerificationResultProps {
  readonly timeZone: string;
  readonly pending: boolean;
  readonly verification: AuditSealVerification | null;
  /** Falha de AUD-05 já classificada; o 422 aparece no painel, não aqui. */
  readonly failure: Exclude<VerifyFailure, { kind: 'validation' }> | null;
  readonly onRetry: () => void;
  readonly onBackToList: () => void;
  /** Caminho a retomar depois do step-up de MFA. */
  readonly returnTo: string;
  /** Recebe o foco quando a verificação conclui (sucesso ou falha). */
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
}

/**
 * `SealVerificationResult` (SCR-037 · AUD-05): estado de carregamento próprio (pode levar segundos),
 * resumo (destaca onde a cadeia foi comprometida), lista por selo com ícone E texto
 * ("Íntegro"/"Quebrado") e o detalhe da quebra, e os erros da verificação (404 volta à lista,
 * 503 oferece "Tentar novamente", MFA leva ao step-up).
 */
export function SealVerificationResult({
  timeZone,
  pending,
  verification,
  failure,
  onRetry,
  onBackToList,
  returnTo,
  headingRef,
}: SealVerificationResultProps) {
  const t = useTranslations('audit.seals.result');
  const tStatus = useTranslations('audit.seals.status');

  if (!pending && verification === null && failure === null) return null;

  const results = verification?.results ?? [];
  const brokenCount = results.filter((item) => item.status === 'INVALID').length;

  let body;
  if (pending) {
    body = (
      <div role="status" aria-busy="true" className="flex flex-col gap-2">
        <p className="text-sm">{t('loading')}</p>
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  } else if (failure !== null) {
    body = (
      <FailureAlert
        failure={failure}
        onRetry={onRetry}
        onBackToList={onBackToList}
        returnTo={returnTo}
      />
    );
  } else if (verification !== null) {
    body = (
      <>
        {verification.brokenAtPeriodStart !== null ? (
          <Alert
            tone="error"
            title={t('chainBroken', {
              date: formatDateTime(verification.brokenAtPeriodStart, timeZone),
            })}
          >
            {t('someBroken', { count: brokenCount })}
          </Alert>
        ) : (
          <Alert tone="success" title={t('allValid', { count: results.length })} />
        )}
        <div className="overflow-x-auto rounded-card border border-border bg-surface shadow-card">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <caption className="sr-only">{t('caption')}</caption>
            <thead className="bg-muted text-xs text-muted-foreground uppercase">
              <tr>
                <th scope="col" className="px-3 py-2">
                  {t('period')}
                </th>
                <th scope="col" className="px-3 py-2 text-right">
                  {t('records')}
                </th>
                <th scope="col" className="px-3 py-2">
                  {t('status')}
                </th>
                <th scope="col" className="px-3 py-2">
                  {t('detail')}
                </th>
              </tr>
            </thead>
            <tbody>
              {results.map((item) => (
                <tr key={item.periodStart} className="border-t border-border align-top">
                  <th scope="row" className="px-3 py-2 font-medium whitespace-nowrap">
                    <time dateTime={item.periodStart}>
                      {formatDateTime(item.periodStart, timeZone)}
                    </time>
                    {' – '}
                    <time dateTime={item.periodEnd}>
                      {formatDateTime(item.periodEnd, timeZone)}
                    </time>
                  </th>
                  <td className="px-3 py-2 text-right tabular-nums">{item.recordCount}</td>
                  <td className="px-3 py-2">
                    <SealStatusBadge status={item.status === 'VALID' ? 'valid' : 'broken'} />
                  </td>
                  <td className="px-3 py-2">
                    {item.status === 'VALID'
                      ? t('validDetail')
                      : item.brokenAt
                        ? t(`break.${item.brokenAt}`)
                        : tStatus('broken')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  }

  return (
    <section aria-labelledby="audit-seal-result-title" className="flex min-w-0 flex-col gap-3">
      <h2
        id="audit-seal-result-title"
        ref={headingRef}
        tabIndex={-1}
        className="text-lg font-semibold outline-none"
      >
        {t('title')}
      </h2>
      {body}
    </section>
  );
}

function FailureAlert({
  failure,
  onRetry,
  onBackToList,
  returnTo,
}: {
  readonly failure: Exclude<VerifyFailure, { kind: 'validation' }>;
  readonly onRetry: () => void;
  readonly onBackToList: () => void;
  readonly returnTo: string;
}) {
  const t = useTranslations('audit.seals.errors');
  switch (failure.kind) {
    case 'notFound':
      return (
        <Alert tone="error" title={AUDIT_SEAL_MESSAGES.notFound}>
          <Button variant="secondary" size="sm" className="mt-2" onClick={onBackToList}>
            {t('backToList')}
          </Button>
        </Alert>
      );
    case 'unavailable':
      return (
        <Alert tone="error" title={AUDIT_SEAL_MESSAGES.unavailable}>
          {failure.correlationId ? (
            <p>{t('unavailableCode', { correlationId: failure.correlationId })}</p>
          ) : null}
          <Button variant="secondary" size="sm" className="mt-2" onClick={onRetry}>
            {t('retry')}
          </Button>
        </Alert>
      );
    case 'mfa':
      return (
        <Alert tone="warning" title={t('mfa')}>
          <a className="font-medium underline" href={stepUpHref(returnTo)}>
            {t('stepUp')}
          </a>
        </Alert>
      );
    case 'forbidden':
      return <Alert tone="error" title={t('forbidden')} />;
    case 'unexpected':
      return (
        <Alert
          tone="error"
          title={t('unexpected', { correlationId: failure.correlationId ?? '—' })}
        >
          <Button variant="secondary" size="sm" className="mt-2" onClick={onRetry}>
            {t('retry')}
          </Button>
        </Alert>
      );
  }
}
