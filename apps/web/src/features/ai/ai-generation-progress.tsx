'use client';

import { Button, Progress } from '@contrataflow/ui';
import type { AiGenerationDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId } from 'react';

export interface AiGenerationProgressProps {
  readonly status: AiGenerationDto['status'];
  readonly stalled: boolean;
  readonly canceling: boolean;
  readonly onCancel: () => void;
}

/** Fração da barra por fase: a API não informa percentual, só a fase (fila → redação). */
const PHASE_PROGRESS = { QUEUED: 20, RUNNING: 60 } as const;

/**
 * `AiGenerationProgress` (SCR-117): "Gerando… você pode continuar editando" — o editor não fica
 * bloqueado. A barra mostra a fase (na fila → redigindo). "Cancelar" chama AI-04 (o servidor
 * descarta a resposta que chegar depois).
 */
export function AiGenerationProgress({
  status,
  stalled,
  canceling,
  onCancel,
}: AiGenerationProgressProps) {
  const t = useTranslations('ai.progress');
  const titleId = useId();
  const phase = status === 'QUEUED' ? t('queued') : t('running');
  return (
    <div className="flex flex-col gap-3" aria-busy="true">
      <p id={titleId} className="font-semibold text-brand-ink">
        {t('title')}
      </p>
      <Progress
        aria-labelledby={titleId}
        value={status === 'QUEUED' ? PHASE_PROGRESS.QUEUED : PHASE_PROGRESS.RUNNING}
        getValueLabel={() => phase}
        className="animate-pulse motion-reduce:animate-none"
      />
      <p className="text-sm text-muted-foreground">{phase}</p>
      {stalled ? <p className="text-sm text-muted-foreground">{t('slow')}</p> : null}
      <div>
        <Button variant="secondary" onClick={onCancel} disabled={canceling}>
          {canceling ? t('canceling') : t('cancel')}
        </Button>
      </div>
    </div>
  );
}
