'use client';

import { cx } from '@contrataflow/ui';
import type { DocumentPresenceEditorDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

/*
 * `PresenceIndicator` (US-070 · SCR-105): quem mais está editando o documento e em qual seção —
 * avatar (iniciais) + nome + seção, com destaque para quem está na MESMA seção do usuário (FA-01:
 * "2 pessoas editando esta seção agora"). Puramente informativo (RN-DOC-94): não bloqueia o
 * teclado nem o salvamento. Sem outros editores (ou com o Redis fora do ar), não aparece. Abaixo de
 * 768 px resume para um contador com a lista no `title` (tooltip) e no texto para leitores de tela.
 */

export interface PresenceIndicatorProps {
  readonly editors: readonly DocumentPresenceEditorDto[];
  /** Seção em foco no editor do usuário atual. */
  readonly currentSectionKey: string | undefined;
  /** Título da seção para exibição (a chave, se a seção não estiver no template). */
  readonly sectionTitle: (sectionKey: string) => string;
  readonly className?: string | undefined;
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

export function PresenceIndicator({
  editors,
  currentSectionKey,
  sectionTitle,
  className,
}: PresenceIndicatorProps) {
  const t = useTranslations('documents.editor.presence');
  if (editors.length === 0) return null;

  const nameOf = (editor: DocumentPresenceEditorDto) => editor.name ?? t('someone');
  const sameSection = editors.filter(
    (editor) => currentSectionKey !== undefined && editor.sectionKey === currentSectionKey,
  );
  const describe = (editor: DocumentPresenceEditorDto) =>
    editor.sectionKey === null
      ? t('openDocument', { name: nameOf(editor) })
      : t('editingSection', { name: nameOf(editor), section: sectionTitle(editor.sectionKey) });
  const [firstSame] = sameSection;
  const warning =
    sameSection.length > 1
      ? t('sameSectionMany', { count: sameSection.length })
      : firstSame === undefined
        ? null
        : t('sameSectionOne', { name: nameOf(firstSame) });
  const summary = editors.map(describe).join('; ');

  return (
    <section
      aria-label={t('label')}
      data-testid="presence-indicator"
      className={cx(
        'flex flex-wrap items-center gap-2 rounded-control border px-3 py-2 text-sm',
        warning === null ? 'border-border' : 'border-warning bg-warning-soft',
        className,
      )}
    >
      <div role="status" className="contents">
        {warning === null ? null : (
          <p className="font-medium text-warning">
            <span aria-hidden="true">⚠ </span>
            {warning}
          </p>
        )}
      </div>

      {/* Telas pequenas: só o contador, com a lista no tooltip e para leitores de tela. */}
      <p className="text-muted-foreground md:hidden" title={summary}>
        <span aria-hidden="true">{t('count', { count: editors.length })}</span>
        <span className="sr-only">{summary}</span>
      </p>

      <ul className="hidden flex-wrap items-center gap-3 md:flex">
        {editors.map((editor) => {
          const same = sameSection.includes(editor);
          return (
            <li
              key={editor.userId}
              data-same-section={same ? 'true' : undefined}
              className="flex items-center gap-1.5"
            >
              <span
                aria-hidden="true"
                className={cx(
                  'flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                  same
                    ? 'border border-warning bg-warning-soft text-warning'
                    : 'bg-primary-soft text-primary',
                )}
              >
                {initialsOf(nameOf(editor))}
              </span>
              <span className="sr-only">{describe(editor)}</span>
              <span aria-hidden="true" className={cx('min-w-0', same && 'font-medium')}>
                {nameOf(editor)}
                {editor.sectionKey === null ? null : (
                  <span className="text-muted-foreground">
                    {' '}
                    · {sectionTitle(editor.sectionKey)}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
