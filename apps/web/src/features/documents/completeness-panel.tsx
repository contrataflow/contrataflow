'use client';

import { Alert, Button, Skeleton } from '@contrataflow/ui';
import { DOCUMENT_MESSAGES } from '@contrataflow/validation';
import type { Violation } from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useId, useMemo, useRef } from 'react';

import { useTenantId } from '@/lib/session/session-context';

import { sortViolations } from './document-errors';
import type { DocumentOutcome } from './document-errors';
import { documentKeys, fetchDocumentValidation } from './documents.api';
import { OutcomeAlert } from './outcome-alert';
import { ViolationList } from './violation-list';

export interface CompletenessPanelProps {
  readonly documentId: string;
  readonly action: 'FINALIZE' | 'SUBMIT';
  /** `violations[]` do 422 `DOCUMENT_INCOMPLETE`/`WARNINGS_NOT_ACKNOWLEDGED`: valem no lugar da consulta. */
  readonly violationsFromError: readonly Violation[] | null;
  readonly pending: boolean;
  readonly feedback: DocumentOutcome | null;
  /** Sem pendências: confirma e envia. */
  readonly onConfirm: () => void;
  /** Só avisos: abre o `AcknowledgeWarningsDialog` com eles. */
  readonly onContinue: (warnings: readonly Violation[]) => void;
  readonly onRetry: () => void;
  readonly onClose: () => void;
}

type Phase = 'loading' | 'error' | 'blocked' | 'warnings' | 'clean';

/**
 * `CompletenessPanel` (US-065 · DOC-08): ao pedir Finalizar/Submeter, lista as pendências do
 * documento — bloqueantes primeiro, avisos depois — e leva o foco à primeira. Com bloqueantes a
 * ação fica desabilitada ("Há pendências que impedem esta ação."); só com avisos segue para o
 * reconhecimento; sem pendências, o usuário confirma e o comando é enviado.
 */
export function CompletenessPanel({
  documentId,
  action,
  violationsFromError,
  pending,
  feedback,
  onConfirm,
  onContinue,
  onRetry,
  onClose,
}: CompletenessPanelProps) {
  const t = useTranslations('documents.completeness');
  const format = useFormatter();
  const tenantId = useTenantId();
  const headingId = useId();
  const blockedId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const firstViolation = useRef<HTMLLIElement>(null);

  // Sempre a leitura de agora: a completude muda a cada edição do documento.
  const validation = useQuery({
    queryKey: documentKeys.validation(tenantId, documentId),
    queryFn: ({ signal }) => fetchDocumentValidation(documentId, signal),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    retry: false,
    throwOnError: false,
  });

  const source = violationsFromError ?? validation.data?.violations ?? null;
  const violations = useMemo(() => (source ? sortViolations(source) : null), [source]);
  const blocking = violations?.filter((violation) => violation.severity === 'BLOCKING') ?? [];
  const warnings = violations ? violations.length - blocking.length : 0;

  let phase: Phase;
  if (violations === null) phase = validation.isError ? 'error' : 'loading';
  else if (blocking.length > 0) phase = 'blocked';
  else if (violations.length > 0) phase = 'warnings';
  else phase = 'clean';

  // Foco: primeira pendência quando há; senão o título do painel (o resultado é anunciado).
  useEffect(() => {
    if (phase === 'blocked' || phase === 'warnings') firstViolation.current?.focus();
    else if (phase === 'clean' || phase === 'error') heading.current?.focus();
  }, [phase, violations]);

  const summary = format.list(
    [
      blocking.length > 0 ? t('summaryBlocking', { count: blocking.length }) : null,
      warnings > 0 ? t('summaryWarnings', { count: warnings }) : null,
    ].filter((part) => part !== null),
    { type: 'conjunction' },
  );

  return (
    <section
      aria-labelledby={headingId}
      aria-busy={phase === 'loading'}
      className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-4 shadow-card"
    >
      <h2
        id={headingId}
        ref={heading}
        tabIndex={-1}
        className="text-base font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t(`heading.${action}`)}
      </h2>

      {phase === 'loading' ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : null}

      {phase === 'error' ? (
        <Alert tone="error" title={t('loadFailed')}>
          <Button
            size="sm"
            variant="secondary"
            className="mt-3"
            onClick={() => {
              void validation.refetch();
            }}
          >
            {t('retry')}
          </Button>
        </Alert>
      ) : null}

      {phase === 'clean' ? <p className="text-sm">{t(`clean.${action}`)}</p> : null}

      {violations && violations.length > 0 ? (
        <>
          <p className="text-sm font-medium">{summary}</p>
          <ViolationList
            label={t('listLabel')}
            violations={violations}
            firstItemRef={firstViolation}
          />
        </>
      ) : null}

      {phase === 'warnings' ? (
        <p className="text-sm text-muted-foreground">{t('warningsHint')}</p>
      ) : null}
      {phase === 'blocked' ? (
        <p id={blockedId} className="text-sm font-medium text-destructive">
          {DOCUMENT_MESSAGES.incomplete}
        </p>
      ) : null}

      <div aria-live="assertive">
        {feedback ? <OutcomeAlert outcome={feedback} onRetry={onRetry} /> : null}
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" disabled={pending} onClick={onClose}>
          {phase === 'blocked' ? t('close') : t('cancel')}
        </Button>
        {phase === 'warnings' ? (
          <Button
            disabled={pending}
            onClick={() => {
              onContinue(violations ?? []);
            }}
          >
            {t('continue')}
          </Button>
        ) : (
          <Button
            disabled={phase !== 'clean' || pending}
            aria-busy={pending}
            aria-describedby={phase === 'blocked' ? blockedId : undefined}
            onClick={onConfirm}
          >
            {pending ? t('working') : t(`confirm.${action}`)}
          </Button>
        )}
      </div>
    </section>
  );
}
