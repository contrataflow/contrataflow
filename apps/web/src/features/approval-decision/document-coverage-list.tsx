import { StatusChip } from '@contrataflow/ui';
import type { ApprovalDocumentDto } from '@contrataflow/validation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useId } from 'react';

import { GeneratePdfButton } from '@/features/documents/generate-pdf-button';

/**
 * `DocumentCoverageList` (US-052 · SCR-015): documentos cobertos pela aprovação, com a versão
 * exata analisada (RN-TRAM-46). Cada título leva à versão (`?versao=`) para a revisão antes de
 * decidir; "Gerar PDF" (US-067 · DOC-21) baixa o PDF oficial dessa versão.
 */
export function DocumentCoverageList({
  processId,
  documents,
}: {
  readonly processId: string;
  readonly documents: readonly ApprovalDocumentDto[];
}) {
  const t = useTranslations('approvals.coverage');
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-3 rounded-card bg-surface p-5 shadow-card"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={headingId} className="text-base font-semibold">
          {t('heading')}
        </h2>
        <span className="text-sm text-muted-foreground">
          {t('count', { count: documents.length })}
        </span>
      </div>
      {documents.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {documents.map((document) => {
            const href = `/processos/${processId}/documentos/${document.documentId}?versao=${document.documentVersionId}`;
            return (
              <li
                key={document.documentVersionId}
                className="flex min-w-0 flex-col gap-2 py-3 first:pt-0 last:pb-0 md:flex-row md:items-start md:justify-between md:gap-4"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <Link
                    href={href}
                    aria-label={t('open', { title: document.title })}
                    className="text-sm font-semibold break-words text-primary-soft-foreground underline-offset-2 hover:underline"
                  >
                    {document.title}
                  </Link>
                  <span className="text-xs break-words text-muted-foreground">
                    {document.code ?? t('noCode')} · {document.typeName ?? document.typeCode}
                  </span>
                </div>
                <div className="flex flex-none flex-wrap items-start gap-2 md:justify-end">
                  <StatusChip tone="neutral">
                    {document.versionNumber === null
                      ? t('noVersion')
                      : t('version', { number: document.versionNumber })}
                  </StatusChip>
                  {document.versionNumber === null ? null : (
                    <GeneratePdfButton
                      source={{
                        kind: 'version',
                        versionId: document.documentVersionId,
                        versionNumber: document.versionNumber,
                      }}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
