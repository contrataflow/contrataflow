'use client';

import { Alert, Button, Skeleton } from '@contrataflow/ui';
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

/**
 * `AiHistoryTab` (SCR-117 · AI-03): quem pediu, quando, tipo, seção, modelo, versão do prompt,
 * tokens e status — sem o texto da proposta. Lista de cartões (cabe em 360 px).
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
  if (query.data.length === 0) return <p className="text-sm text-muted-foreground">{t('empty')}</p>;

  return (
    <ul className="flex flex-col gap-3" aria-label={t('title')}>
      {query.data.map((item: AiGenerationListItemDto) => (
        <li key={item.id} className="rounded-md border border-border p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">{t(`kind.${item.kind}`)}</span>
            <span className="rounded bg-muted px-2 py-0.5 text-xs">
              {t(`status.${item.status}`)}
            </span>
          </div>
          <p className="text-muted-foreground">
            {t('by', { name: item.requestedBy.name })} · {formatDateTime(item.createdAt, timeZone)}
          </p>
          {item.sectionKey ? <p className="text-muted-foreground">{item.sectionKey}</p> : null}
          <p className="text-muted-foreground">
            {item.model ? t('model', { model: item.model, version: item.promptVersion }) : null}
          </p>
          <p className="text-muted-foreground">
            {t('tokens', { count: item.usage.totalTokens ?? 0 })}
          </p>
          {item.status === 'SUCCEEDED' || item.status === 'QUEUED' || item.status === 'RUNNING' ? (
            <Button
              variant="secondary"
              className="mt-2"
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
