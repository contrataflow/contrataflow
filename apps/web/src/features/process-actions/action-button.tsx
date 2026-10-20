'use client';

import { Button, cx } from '@contrataflow/ui';
import type { ActionEntry } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId } from 'react';

export interface ActionButtonProps {
  readonly entry: ActionEntry;
  /** Ação habilitada escolhida (os comandos de tramitação são das stories donas). */
  readonly onSelect?: ((entry: ActionEntry) => void) | undefined;
}

/**
 * `ActionButton` (US-041): ação do painel situacional. Indisponível continua focável — `aria-disabled`
 * e `aria-describedby` apontando para os motivos (`reasons[]`), exibidos em tooltip no hover e no
 * foco — para que o leitor de tela e o teclado expliquem por que a ação não pode ser feita agora.
 */
export function ActionButton({ entry, onSelect }: ActionButtonProps) {
  const t = useTranslations('processActions');
  const reasonsId = useId();
  const disabled = !entry.enabled;
  const reasons = entry.reasons.map((reason) => reason.message).join(' · ');
  return (
    <span className="group relative inline-flex">
      <Button
        size="sm"
        variant={entry.primary === true && !disabled ? 'primary' : 'secondary'}
        aria-disabled={disabled ? true : undefined}
        aria-describedby={disabled ? reasonsId : undefined}
        data-action={entry.action}
        className={cx(disabled && 'cursor-not-allowed opacity-60')}
        onClick={() => {
          if (!disabled) onSelect?.(entry);
        }}
      >
        {entry.label}
      </Button>
      {disabled ? (
        <span
          id={reasonsId}
          role="tooltip"
          className="pointer-events-none invisible absolute top-full left-0 z-10 mt-1 w-64 max-w-[80vw] rounded-control border bg-background p-2 text-xs text-foreground shadow-md group-focus-within:visible group-hover:visible"
        >
          {t('actions.unavailable', { reasons })}
        </span>
      ) : null}
    </span>
  );
}
