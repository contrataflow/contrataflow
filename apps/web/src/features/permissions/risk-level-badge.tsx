import type { PermissionRiskLevel } from '@contrataflow/types';
import { useTranslations } from 'next-intl';

const TONE: Record<PermissionRiskLevel, string> = {
  LOW: 'bg-success-soft text-foreground',
  MEDIUM: 'bg-warning-soft text-foreground',
  HIGH: 'bg-destructive-soft text-foreground',
};

/** Nível de risco da permissão: o texto carrega o significado, a cor só reforça (WCAG 1.4.1). */
export function RiskLevelBadge({ level }: { readonly level: PermissionRiskLevel }) {
  const t = useTranslations('permissions.risk');
  return (
    <span
      data-risk={level}
      className={`inline-flex rounded-control border border-border px-2 py-0.5 text-xs font-medium ${TONE[level]}`}
    >
      {t(level)}
    </span>
  );
}
