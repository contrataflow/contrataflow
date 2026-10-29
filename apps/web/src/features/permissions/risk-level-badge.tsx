import type { PermissionRiskLevel } from '@contrataflow/types';
import { StatusChip } from '@contrataflow/ui';
import type { StatusTone } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';

const TONE: Record<PermissionRiskLevel, StatusTone> = {
  LOW: 'success',
  MEDIUM: 'warning',
  HIGH: 'danger',
};

/** Nível de risco da permissão: o texto carrega o significado, a cor só reforça (WCAG 1.4.1). */
export function RiskLevelBadge({ level }: { readonly level: PermissionRiskLevel }) {
  const t = useTranslations('permissions.risk');
  return (
    <StatusChip tone={TONE[level]} data-risk={level}>
      {t(level)}
    </StatusChip>
  );
}
