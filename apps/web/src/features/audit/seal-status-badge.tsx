import { useTranslations } from 'next-intl';

import { Icon } from '@/components/shell/icons';
import type { IconName } from '@/components/shell/icons';

import type { SealStatus } from './seal-model';

const TONES: Readonly<Record<SealStatus, { readonly icon: IconName; readonly classes: string }>> = {
  unverified: { icon: 'clock', classes: 'bg-muted text-muted-foreground' },
  valid: { icon: 'check', classes: 'bg-success-soft text-foreground' },
  broken: { icon: 'alert', classes: 'bg-destructive-soft text-foreground' },
};

/**
 * Status do selo: ícone E texto ("Não verificado", "Íntegro", "Quebrado") — a cor nunca é a única
 * informação (SCR-037 · acessibilidade).
 */
export function SealStatusBadge({ status }: { readonly status: SealStatus }) {
  const t = useTranslations('audit.seals.status');
  const tone = TONES[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-control px-2 py-0.5 text-xs font-medium whitespace-nowrap ${tone.classes}`}
    >
      <Icon name={tone.icon} className="size-3.5" />
      {t(status)}
    </span>
  );
}
