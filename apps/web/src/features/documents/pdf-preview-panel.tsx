'use client';

import { RENDITION_LIMITS } from '@contrataflow/validation';
import type { DocumentRenditionDto } from '@contrataflow/validation';
import { useFormatter, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

/** Quantos caracteres do SHA-256 aparecem (o hash completo fica no `title`). */
const HASH_PREFIX = 12;

export interface PdfPreviewPanelProps {
  readonly rendition: DocumentRenditionDto;
  /** Ações do PDF (ex.: "Baixar PDF"), à direita em telas largas e abaixo nas estreitas. */
  readonly children?: ReactNode;
}

function sizeOf(bytes: number): { readonly unit: 'B' | 'KB' | 'MB'; readonly value: number } {
  if (bytes < 1024) return { unit: 'B', value: bytes };
  if (bytes < 1024 * 1024) return { unit: 'KB', value: bytes / 1024 };
  return { unit: 'MB', value: bytes / (1024 * 1024) };
}

/**
 * `PdfPreviewPanel` (US-067): painel do PDF pronto — páginas, tamanho, hash SHA-256 abreviado,
 * validade da prévia e o aviso de POL-09, mais as ações. É um resumo, não um visualizador:
 * o `apps/web` ainda não tem o pdf.js (a story prevê o visualizador com ele), e a dependência nova
 * depende de aprovação. Quando entrar, o visualizador vira o conteúdo deste painel em telas
 * largas; abaixo de 768 px o painel segue só com o resumo e "Baixar PDF", sem `iframe`
 * (`frame-src 'none'`).
 */
export function PdfPreviewPanel({ rendition, children }: PdfPreviewPanelProps) {
  const t = useTranslations('documents.renditions.panel');
  const format = useFormatter();
  const size = rendition.sizeBytes === null ? null : sizeOf(rendition.sizeBytes);
  return (
    <section
      aria-label={t('label')}
      className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-4 sm:flex-row sm:items-start sm:justify-between"
    >
      <div className="flex min-w-0 flex-col gap-2">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          {rendition.pageCount === null ? null : (
            <>
              <dt className="text-muted-foreground">{t('pages')}</dt>
              <dd>{format.number(rendition.pageCount)}</dd>
            </>
          )}
          {size === null ? null : (
            <>
              <dt className="text-muted-foreground">{t('size')}</dt>
              <dd>
                {t(`units.${size.unit}`, {
                  value: format.number(size.value, { maximumFractionDigits: 1 }),
                })}
              </dd>
            </>
          )}
          {rendition.sha256 === null ? null : (
            <>
              <dt className="text-muted-foreground">{t('hash')}</dt>
              <dd>
                <code title={rendition.sha256}>{rendition.sha256.slice(0, HASH_PREFIX)}</code>
              </dd>
            </>
          )}
          {rendition.expiresAt === null ? null : (
            <>
              <dt className="text-muted-foreground">{t('validUntil')}</dt>
              <dd>
                {format.dateTime(new Date(rendition.expiresAt), {
                  dateStyle: 'short',
                  timeStyle: 'short',
                })}
              </dd>
            </>
          )}
        </dl>
        {rendition.kind === 'PREVIEW' ? (
          <p className="text-xs text-muted-foreground">
            {t('previewNote', { hours: RENDITION_LIMITS.previewTtlHours })}
          </p>
        ) : null}
        {rendition.masked ? <p className="text-sm font-medium">{t('masked')}</p> : null}
      </div>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </section>
  );
}
