'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  toast,
} from '@contrataflow/ui';
import { RISK_MESSAGES, TREATMENT_TYPE_LABELS } from '@contrataflow/validation';
import type { RiskDto } from '@contrataflow/validation';
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { riskProblemOf } from './risks-model';
import type { RiskProblem } from './risks-model';
import { deleteRisk } from './risks.api';

export interface DeleteRiskDialogProps {
  /** Risco a excluir (`null` = fechado); sempre a versão mais recente da lista. */
  readonly risk: RiskDto | null;
  readonly onClose: () => void;
  readonly scaleMax: number;
  /** Recarrega a lista e o painel (sucesso, 412 e recusas por estado). */
  readonly onChanged: () => Promise<void> | void;
}

/**
 * `DeleteRiskDialog` (US-033 · fluxo principal, passo 9 · RN-RISK-10): confirma a exclusão e, quando
 * há tratamentos vinculados, lista-os antes (a exclusão leva os tratamentos junto). Erros: 412
 * recarrega e avisa; 409/403/422 mostram o motivo; 503 mantém o diálogo para tentar de novo.
 */
export function DeleteRiskDialog({ risk, onClose, scaleMax, onChanged }: DeleteRiskDialogProps) {
  const t = useTranslations('risks.remove');
  const [problem, setProblem] = useState<RiskProblem | null>(null);
  const close = () => {
    setProblem(null);
    onClose();
  };

  const remove = useMutation({
    mutationFn: (target: RiskDto) => deleteRisk(target.id, target.version),
    onSuccess: async (_data, target) => {
      toast({ title: t('toast', { code: target.code }), tone: 'success' });
      close();
      await onChanged();
    },
    onError: (error: unknown) => {
      const found = riskProblemOf(error, scaleMax);
      if (found.kind === 'stale') {
        toast({ title: RISK_MESSAGES.versionConflict, tone: 'error' });
        void onChanged();
        close();
        return;
      }
      if (found.kind === 'notFound') {
        void onChanged();
        close();
        return;
      }
      if (found.kind === 'permission' || found.kind === 'blocked') void onChanged();
      setProblem(found);
    },
  });

  const treatments = risk?.treatments ?? [];
  return (
    <Dialog
      open={risk !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent closeLabel={null}>
        <DialogTitle>{t('title', { code: risk?.code ?? '' })}</DialogTitle>
        <DialogDescription>
          {risk === null ? '' : t('description', { code: risk.code, title: risk.title })}
        </DialogDescription>
        {treatments.length > 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">{t('treatments', { count: treatments.length })}</p>
            <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto text-sm">
              {treatments.map((treatment) => (
                <li key={treatment.id} className="rounded-control border border-border p-2">
                  <span className="font-medium">{TREATMENT_TYPE_LABELS[treatment.type]}</span>
                  {' · '}
                  <span className="text-muted-foreground">
                    {t(`treatmentStatus.${treatment.status}` as 'treatmentStatus.PLANNED')}
                  </span>
                  <span className="block break-words">{treatment.description}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div aria-live="polite">
          {problem?.kind === 'permission' ? (
            <Alert tone="error" title={RISK_MESSAGES.permissionDenied} />
          ) : null}
          {problem?.kind === 'blocked' ? <Alert tone="error" title={problem.message} /> : null}
          {problem?.kind === 'unavailable' ? <Alert tone="error" title={t('unavailable')} /> : null}
          {problem?.kind === 'unexpected' ? (
            <Alert tone="error" title={t('unexpected', { correlationId: problem.correlationId })} />
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={close}>
            {t('cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => {
              setProblem(null);
              if (risk !== null) remove.mutate(risk);
            }}
          >
            {problem?.kind === 'unavailable'
              ? t('retry')
              : treatments.length > 0
                ? t('confirmWithTreatments')
                : t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
