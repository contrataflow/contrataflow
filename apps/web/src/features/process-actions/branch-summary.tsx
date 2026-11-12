'use client';

import { StatusChip } from '@contrataflow/ui';
import type { BranchSiblingDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

/*
 * Ramos paralelos nas leituras (US-125 · RN-WF2-30/37/38 · SCR-013/SCR-014/SCR-015): o chip do ramo
 * da linha e o resumo dos outros ramos ("Também em andamento: Análise jurídica"). O paralelismo é
 * comunicado por texto e ícone, nunca só por cor; os irmãos trazem só o nome da etapa e a situação
 * (sem pessoas nem valores — POL-09). Fora do paralelismo nada é renderizado (UI do MVP 1).
 */

/** "Ramo: Controle interno" — o rótulo do ramo da linha. */
export function BranchLabelChip({ label }: { readonly label: string | null | undefined }) {
  const t = useTranslations('processActions.branchReads');
  if (label === null || label === undefined || label === '') return null;
  return (
    <StatusChip tone="info" aria-label={t('chipLabel', { branch: label })}>
      <span aria-hidden="true" className="me-1">
        ⑂
      </span>
      {t('chip', { branch: label })}
    </StatusChip>
  );
}

/** "Também em andamento: Análise jurídica (atrasado) · Revisão (concluído) e mais 1". */
export function SiblingsSummary({
  siblings,
  more,
}: {
  readonly siblings: readonly BranchSiblingDto[] | undefined;
  readonly more: number | undefined;
}) {
  const t = useTranslations('processActions.branchReads');
  if (siblings === undefined || siblings.length === 0) return null;
  const parts = siblings.map((sibling) => {
    const situation =
      sibling.status === 'ARRIVED' ? t('arrived') : sibling.isOverdue ? t('overdue') : null;
    return situation === null ? sibling.stageName : `${sibling.stageName} (${situation})`;
  });
  return (
    <span className="text-xs text-muted-foreground">
      {t('siblings', { list: parts.join(' · ') })}
      {more !== undefined && more > 0 ? ` ${t('more', { count: more })}` : ''}
    </span>
  );
}
