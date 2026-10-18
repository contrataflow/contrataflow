'use client';

import { Alert } from '@contrataflow/ui';
import type { ProcessSummaryDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

import { formatDate } from '@/lib/i18n/format';

/**
 * `SuspendedBanner` (US-008 · SCR-006, fluxo principal 5): com o processo suspenso, o painel mostra
 * "Suspenso desde DD/MM/AAAA — {motivo}" em destaque (ícone e texto, não só cor). O badge "Prazo
 * pausado" vem do DTO `deadline` (US-055).
 */
export function SuspendedBanner({
  where,
  timeZone,
}: {
  readonly where: ProcessSummaryDto['where'];
  readonly timeZone: string;
}) {
  const t = useTranslations('processes.suspension');
  if (where.status !== 'SUSPENDED' || where.suspendedAt === null) return null;
  return (
    <Alert
      tone="warning"
      title={t('banner', {
        date: formatDate(where.suspendedAt, timeZone),
        reason: where.suspensionReason ?? '—',
      })}
    />
  );
}
