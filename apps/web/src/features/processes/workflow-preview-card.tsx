'use client';

import { Alert, Button, Skeleton } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';
import { useId } from 'react';

export type WorkflowPreviewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly name: string; readonly stage: string }
  /** `NO_APPLICABLE_WORKFLOW` (FA-06): bloqueia a criação. */
  | { readonly kind: 'none' }
  /** Falha ao consultar o WF-06: a criação segue, quem resolve o fluxo é a API. */
  | { readonly kind: 'unavailable'; readonly onRetry: () => void };

/**
 * `WorkflowPreviewCard` (passo 3 · WF-06): "Este processo seguirá o fluxo X, começando em Y" ou,
 * sem fluxo aplicável, a orientação de falar com o administrador do órgão (FA-06).
 */
export function WorkflowPreviewCard({ state }: { readonly state: WorkflowPreviewState }) {
  const t = useTranslations('processes');
  const headingId = useId();
  let body;
  if (state.kind === 'loading') {
    body = (
      <div role="status">
        <span className="sr-only">{t('workflow.loading')}</span>
        <Skeleton className="h-5 w-full max-w-md" />
      </div>
    );
  } else if (state.kind === 'ready') {
    body = (
      <p>
        {t.rich('workflow.preview', {
          name: state.name,
          stage: state.stage,
          strong: (chunks) => <strong>{chunks}</strong>,
        })}
      </p>
    );
  } else if (state.kind === 'none') {
    body = <Alert tone="error" title={t('workflow.none')} />;
  } else {
    body = (
      <Alert tone="warning" title={t('workflow.unavailable')}>
        <Button size="sm" variant="secondary" className="mt-2" onClick={state.onRetry}>
          {t('workflow.retry')}
        </Button>
      </Alert>
    );
  }
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2 rounded-card border border-border bg-surface p-4 text-sm"
    >
      <h3 id={headingId} className="text-sm font-semibold">
        {t('workflow.title')}
      </h3>
      {body}
    </section>
  );
}
