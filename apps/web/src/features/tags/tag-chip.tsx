'use client';

import { cx } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';

import { TAG_TEXT_COLOR } from './tag-model';

/**
 * `TagChip` (US-007): cor + nome. A cor é só apoio — o nome está sempre visível (acessibilidade) —,
 * e a etiqueta inativa já aplicada aparece esmaecida (contorno tracejado na cor, sem preenchimento,
 * texto neutro: o contraste AA se mantém) com o rótulo "(inativa)" (FA-03).
 */
export function TagChip({
  name,
  color,
  isActive = true,
  className,
}: {
  readonly name: string;
  readonly color: string | null;
  readonly isActive?: boolean;
  readonly className?: string;
}) {
  const t = useTranslations('tags.chip');
  return (
    <span
      className={cx(
        'inline-flex max-w-full items-center gap-1 rounded-control px-2 py-0.5 text-xs font-medium',
        isActive
          ? color === null
            ? 'bg-muted text-foreground'
            : undefined
          : 'border border-dashed border-border bg-surface text-muted-foreground',
        className,
      )}
      style={
        color === null
          ? undefined
          : isActive
            ? { backgroundColor: color, color: TAG_TEXT_COLOR }
            : { borderColor: color }
      }
    >
      <span className="truncate">{name}</span>
      {isActive ? null : <span className="shrink-0">{t('inactive')}</span>}
    </span>
  );
}
