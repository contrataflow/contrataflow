'use client';

import { Alert, Button, buttonClassName, toast } from '@contrataflow/ui';
import { RISK_MAP_MESSAGES } from '@contrataflow/validation';
import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';

import { newIdempotencyKey } from '@/lib/api/client';

import { emitOutcomeOf } from './risk-matrix-model';
import type { EmitOutcome, RiskMapAction } from './risk-matrix-model';
import { createRiskMap, riskMapHref } from './risks.api';
import { useInvalidateProcess } from '../process-panel/process-panel.api';

export interface EmitRiskMapButtonProps {
  readonly processId: string;
  readonly action: RiskMapAction;
}

/**
 * `EmitRiskMapButton` (US-035 · fluxo principal 3 · FA-01/FA-02): sem Mapa de Riscos, "Emitir Mapa
 * de Riscos" (RSK-10, uma `Idempotency-Key` por intenção) e, criado, a navegação para a tela do
 * documento; desabilitado sem riscos (FA-02) e ausente sem permissão. Com o mapa já emitido, o link
 * "Abrir o Mapa de Riscos" — e, concluído, o aviso "Mapa de Riscos concluído" (RN-RISK-23). Um 409
 * oferece abrir o existente em vez de criar outro.
 */
export function EmitRiskMapButton({ processId, action }: EmitRiskMapButtonProps) {
  const t = useTranslations('risks.riskMap');
  const router = useRouter();
  const invalidate = useInvalidateProcess(processId);
  const hintId = useId();
  const [outcome, setOutcome] = useState<EmitOutcome | null>(null);
  const key = useRef<string | null>(null);

  const emit = useMutation({
    mutationFn: () => {
      key.current ??= newIdempotencyKey();
      return createRiskMap(processId, key.current);
    },
    onSuccess: (document) => {
      key.current = null;
      toast({
        title:
          document.code === null
            ? t('toast.createdNoCode')
            : t('toast.created', { code: document.code }),
        tone: 'success',
      });
      void invalidate();
      router.push(riskMapHref(processId, document.id));
    },
    onError: (error: unknown) => {
      const next = emitOutcomeOf(error);
      setOutcome(next);
      // A recusa definitiva encerra a intenção; indisponibilidade mantém a chave para reenviar.
      if (next.kind !== 'unavailable') key.current = null;
      if (next.kind !== 'unavailable' && next.kind !== 'failed') void invalidate();
    },
  });

  if (action.kind === 'none') return null;
  if (action.kind === 'open' || action.kind === 'completed') {
    const label = action.code === null ? t('open') : t('openNamed', { code: action.code });
    const link = (
      <Link
        href={riskMapHref(processId, action.documentId)}
        className={buttonClassName({ variant: 'secondary', size: 'sm' })}
      >
        {label}
      </Link>
    );
    if (action.kind === 'open') return link;
    return (
      <Alert tone="info" title={action.rejected ? t('rejected') : t('completed')}>
        <p className="text-sm">{t('completedHint')}</p>
        <div className="mt-2">{link}</div>
      </Alert>
    );
  }

  return (
    <div className="flex min-w-0 flex-col items-start gap-2">
      <Button
        disabled={action.disabled || emit.isPending}
        aria-describedby={action.disabled ? hintId : undefined}
        onClick={() => {
          setOutcome(null);
          emit.mutate();
        }}
      >
        {emit.isPending ? t('emitting') : t('emit')}
      </Button>
      {action.disabled ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {t('emptyHint')}
        </p>
      ) : null}
      {outcome === null ? null : <EmitOutcomeAlert processId={processId} outcome={outcome} />}
    </div>
  );
}

function EmitOutcomeAlert({
  processId,
  outcome,
}: {
  readonly processId: string;
  readonly outcome: EmitOutcome;
}) {
  const t = useTranslations('risks.riskMap');
  switch (outcome.kind) {
    case 'exists':
      return (
        <Alert tone="warning" title={RISK_MAP_MESSAGES.alreadyExists}>
          {outcome.documentId === null ? null : (
            <Link
              href={riskMapHref(processId, outcome.documentId)}
              className="text-sm text-primary underline"
            >
              {t('openExisting')}
            </Link>
          )}
        </Alert>
      );
    case 'empty':
      return <Alert tone="warning" title={RISK_MAP_MESSAGES.listEmpty} />;
    case 'forbidden':
      return <Alert tone="error" title={RISK_MAP_MESSAGES.createDenied} />;
    case 'notEditable':
      return <Alert tone="warning" title={t('errors.notEditable')} />;
    case 'typeNotAllowed':
      return <Alert tone="warning" title={RISK_MAP_MESSAGES.typeNotAllowedInStage} />;
    case 'unavailable':
      return <Alert tone="error" title={RISK_MAP_MESSAGES.unavailable} />;
    case 'failed':
      return (
        <Alert
          tone="error"
          title={t('errors.unexpected', { code: outcome.correlationId ?? '—' })}
        />
      );
  }
}
