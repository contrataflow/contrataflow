import { Lock } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

/**
 * Campo restrito de tipo de sistema (US-061 · passo 8): valor em texto com cadeado e a explicação
 * "Definido pela plataforma" — nunca um controle desabilitado sem motivo (RN-DOC-03).
 */
export function LockedField({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  const t = useTranslations('documentTypes.form');
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-semibold text-foreground">{label}</span>
      <p className="flex flex-wrap items-center gap-2 text-sm text-foreground">
        <Lock
          role="img"
          aria-label={t('lockedField', { label })}
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span>{children}</span>
        <span className="text-[0.8125rem] text-muted-foreground">{t('locked')}</span>
      </p>
    </div>
  );
}
