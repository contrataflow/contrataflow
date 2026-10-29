'use client';

import { Alert, Button, EmptyState, History, Skeleton, StatusChip } from '@contrataflow/ui';
import type { StatusTone } from '@contrataflow/ui';
import type { AiGenerationListItemDto } from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import { formatDateTime } from '@/lib/i18n/format';
import { useShellSession, useTenantId } from '@/lib/session/session-context';

import { aiKeys, fetchAiHistory } from './ai.api';

export interface AiHistoryTabProps {
  readonly processId: string;
  /** Abre a geração no painel (proposta ou acompanhamento). */
  readonly onOpen: (generationId: string) => void;
}

const STATUS_TONE: Readonly<Record<AiGenerationListItemDto['status'], StatusTone>> = {
  QUEUED: 'info',
  RUNNING: 'info',
  SUCCEEDED: 'success',
  FAILED: 'danger',
  CANCELED: 'neutral',
  APPLIED: 'approval',
  DISCARDED: 'neutral',
  EXPIRED: 'warning',
};

/**
 * `AiHistoryTab` (SCR-117 · AI-03): quem pediu, quando, tipo, seção, modelo, versão do prompt,
 * tokens e status — sem o texto da proposta. Lista compacta: tipo e situação em destaque, o resto
 * numa linha secundária (cabe em 360 px).
 */
export function AiHistoryTab({ processId, onOpen }: AiHistoryTabProps) {
  const t = useTranslations('ai.history');
  const tenantId = useTenantId();
  const timeZone = useShellSession().activeTenant.timezone;
  const query = useQuery({
    queryKey: aiKeys.history(tenantId, processId),
    queryFn: ({ signal }) => fetchAiHistory(processId, signal),
    throwOnError: false,
  });

  if (query.isPending) {
    return (
      <div role="status" className="flex flex-col gap-3">
        <span className="sr-only">{t('loading')}</span>
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <Alert tone="error" title={t('loadFailed')}>
        <Button
          variant="secondary"
          onClick={() => {
            void query.refetch();
          }}
        >
          {t('retry')}
        </Button>
      </Alert>
    );
  }
  if (query.data.length === 0) {
    return <EmptyState icon={<History />} title={t('empty')} />;
  }

  return (
    <ul className="flex flex-col divide-y divide-border" aria-label={t('title')}>
      {query.data.map((item: AiGenerationListItemDto) => (
        <li key={item.id} className="flex flex-col gap-1 py-3 text-sm first:pt-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-brand-ink">{t(`kind.${item.kind}`)}</span>
            <StatusChip tone={STATUS_TONE[item.status]}>{t(`status.${item.status}`)}</StatusChip>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('by', { name: item.requestedBy.name })} · {formatDateTime(item.createdAt, timeZone)}
            {item.sectionKey ? ` · ${item.sectionKey}` : null}
          </p>
          <p className="text-xs text-muted-foreground">
            {item.model
              ? `${t('model', { model: item.model, version: item.promptVersion })} · `
              : null}
            {t('tokens', { count: item.usage.totalTokens ?? 0 })}
          </p>
          {item.status === 'SUCCEEDED' || item.status === 'QUEUED' || item.status === 'RUNNING' ? (
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() => {
                onOpen(item.id);
              }}
            >
              {t('open')}
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
