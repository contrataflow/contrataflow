'use client';

import { Button, Skeleton } from '@contrataflow/ui';
import type { AiGenerationDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

export interface AiGenerationProgressProps {
  readonly status: AiGenerationDto['status'];
  readonly stalled: boolean;
  readonly canceling: boolean;
  readonly onCancel: () => void;
}

/**
 * `AiGenerationProgress` (SCR-117): "Gerando… você pode continuar editando" — o editor não fica
 * bloqueado. "Cancelar" chama AI-04 (o servidor descarta a resposta que chegar depois).
 */
export function AiGenerationProgress({
  status,
  stalled,
  canceling,
  onCancel,
}: AiGenerationProgressProps) {
  const t = useTranslations('ai.progress');
  return (
    <div className="flex flex-col gap-3" aria-busy="true">
      <p className="font-medium">{t('title')}</p>
      <p className="text-sm text-muted-foreground">
        {status === 'QUEUED' ? t('queued') : t('running')}
      </p>
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-4/5" />
      <Skeleton className="h-3 w-3/5" />
      {stalled ? <p className="text-sm text-muted-foreground">{t('slow')}</p> : null}
      <div>
        <Button variant="secondary" onClick={onCancel} disabled={canceling}>
          {canceling ? t('canceling') : t('cancel')}
        </Button>
      </div>
    </div>
  );
}
