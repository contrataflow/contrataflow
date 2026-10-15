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
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium">{label}</span>
      <p className="flex items-center gap-2 text-sm text-foreground">
        <svg
          role="img"
          aria-label={t('lockedField', { label })}
          viewBox="0 0 24 24"
          className="size-4 shrink-0 text-muted-foreground"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <rect x="5" y="11" width="14" height="9" rx="2" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" />
        </svg>
        <span>{children}</span>
        <span className="text-xs text-muted-foreground">{t('locked')}</span>
      </p>
    </div>
  );
}
