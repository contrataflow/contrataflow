'use client';

import { Button } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';
import { useId } from 'react';

import type { WizardStep } from './process-form-model';

export interface SummaryRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

export interface SummarySection {
  readonly step: Exclude<WizardStep, 'review'>;
  readonly rows: readonly SummaryRow[];
}

export interface ReviewSummaryProps {
  readonly sections: readonly SummarySection[];
  readonly onEdit: (step: Exclude<WizardStep, 'review'>) => void;
}

/** `ReviewSummary` (passo 3): o que foi informado, por passo, com "Editar" para voltar a ele. */
export function ReviewSummary({ sections, onEdit }: ReviewSummaryProps) {
  const t = useTranslations('processes');
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <h3 id={headingId} className="text-base font-semibold">
        {t('review.summary')}
      </h3>
      {sections.map((section) => {
        const title = t(`wizard.steps.${section.step}`);
        return (
          <div
            key={section.step}
            className="flex min-w-0 flex-col gap-2 rounded-card border border-border bg-surface p-4"
          >
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-sm font-semibold">{title}</h4>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`${t('wizard.actions.edit')} ${title}`}
                onClick={() => {
                  onEdit(section.step);
                }}
              >
                {t('wizard.actions.edit')}
              </Button>
            </div>
            <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
              {section.rows.map((row) => (
                <div key={row.key} className="contents">
                  <dt className="text-muted-foreground">{row.label}</dt>
                  <dd className="min-w-0 break-words">{row.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        );
      })}
    </section>
  );
}
