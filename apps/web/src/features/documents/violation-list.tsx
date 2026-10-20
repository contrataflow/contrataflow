import type { Violation } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import type { Ref } from 'react';

import { aiSectionAnchor } from './ai-review-model';

/** Violações de IA (RN-AI-57) com link para a seção no painel "Conteúdo gerado por IA". */
const AI_SECTION_CODES: ReadonlySet<string> = new Set([
  'SECTION_AI_REVIEW_PENDING',
  'SECTION_PLACEHOLDER_PENDING',
]);

export interface ViolationListProps {
  readonly label: string;
  /** Na ordem de exibição (bloqueantes primeiro). */
  readonly violations: readonly Violation[];
  /** Recebe o foco quando o painel abre (a primeira pendência). */
  readonly firstItemRef?: Ref<HTMLLIElement> | undefined;
}

/**
 * Lista de `violations[]` do DOC-08 (e do 422): a gravidade vem em texto ("Bloqueante"/"Aviso"),
 * nunca só na cor, e `sectionKey`/`field`, quando existem, aparecem como referência. As pendências
 * de IA (US-122) levam o link para a seção no painel "Conteúdo gerado por IA".
 */
export function ViolationList({ label, violations, firstItemRef }: ViolationListProps) {
  const t = useTranslations('documents.completeness');
  return (
    <ul aria-label={label} className="flex flex-col gap-2">
      {violations.map((violation, index) => {
        const blocking = violation.severity === 'BLOCKING';
        const references = [
          violation.sectionKey ? t('section', { key: violation.sectionKey }) : null,
          violation.field ? t('field', { field: violation.field }) : null,
        ].filter((reference) => reference !== null);
        return (
          <li
            key={`${violation.code}:${violation.sectionKey ?? ''}:${violation.field ?? ''}:${violation.itemId ?? ''}:${String(index)}`}
            ref={index === 0 ? firstItemRef : undefined}
            tabIndex={index === 0 && firstItemRef ? -1 : undefined}
            className={`flex min-w-0 flex-col gap-1 rounded-control border-l-4 p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              blocking ? 'border-destructive bg-destructive-soft' : 'border-warning bg-warning-soft'
            }`}
          >
            <span className="text-xs font-semibold tracking-wide uppercase">
              {blocking ? t('blocking') : t('warning')}
            </span>
            <span className="break-words">{violation.message}</span>
            {references.length > 0 ? (
              <span className="text-xs break-words text-muted-foreground">
                {references.join(' · ')}
              </span>
            ) : null}
            {violation.sectionKey && AI_SECTION_CODES.has(violation.code) ? (
              <a
                href={`#${aiSectionAnchor(violation.sectionKey)}`}
                className="text-xs text-primary underline"
              >
                {t('goToSection', { key: violation.sectionKey })}
              </a>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
