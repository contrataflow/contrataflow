'use client';

import type { QuotationImportPreview } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId } from 'react';

import { previewIssues } from './quotation-import-model';

/**
 * `ImportPreviewTable` (US-028 · SCR-009): o resumo da prévia (células válidas, com erro, vazias e
 * com aviso — anunciado por `aria-live` quando a prévia chega) e a lista de problemas por
 * linha/coluna na ordem da planilha, numa região rolável alcançável pelo teclado.
 */
export function ImportPreviewTable({ preview }: { readonly preview: QuotationImportPreview }) {
  const t = useTranslations('priceResearch.sources.import');
  const titleId = useId();
  const issues = previewIssues(preview);
  const { summary } = preview;

  return (
    <section aria-labelledby={titleId} className="flex min-w-0 flex-col gap-3">
      <h3 id={titleId} className="font-medium">
        {t('summaryTitle')}
      </h3>
      <p className="text-sm text-muted-foreground">{t('fileName', { name: preview.fileName })}</p>
      <p role="status" aria-live="polite" className="text-sm">
        {t('summary', {
          valid: summary.valid,
          errors: summary.errors,
          empty: summary.empty,
          warnings: summary.warnings,
        })}
      </p>
      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        {(['valid', 'errors', 'empty', 'warnings'] as const).map((key) => (
          <div key={key} className="rounded-card border border-border p-2">
            <dt className="text-muted-foreground">{t(`counts.${key}`)}</dt>
            <dd className="text-lg font-semibold">{summary[key]}</dd>
          </div>
        ))}
      </dl>
      {issues.length === 0 ? (
        <p className="text-sm">{t('noIssues')}</p>
      ) : (
        <div
          role="region"
          aria-label={t('issuesLabel')}
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- região rolável precisa de foco (axe): setas/PageDown percorrem a lista
          tabIndex={0}
          className="max-h-64 min-w-0 overflow-y-auto rounded-card border border-border p-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ul className="flex min-w-0 flex-col gap-1">
            {issues.map((issue, index) => (
              <li
                key={`${String(issue.row)}:${issue.column ?? ''}:${issue.code}:${String(index)}`}
                className="flex min-w-0 gap-2"
              >
                <span
                  className={
                    issue.severity === 'ERROR'
                      ? 'shrink-0 font-semibold text-destructive'
                      : 'shrink-0 font-semibold text-warning'
                  }
                >
                  {t(`severity.${issue.severity}`)}
                </span>
                <span className="min-w-0 break-words">{issue.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
