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
import { TREATMENT_TYPE_LABELS } from '@contrataflow/validation';
import type { RiskDto, RiskTreatmentDto } from '@contrataflow/validation';
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { deleteTreatment } from './risks.api';
import { treatmentProblemMessage, treatmentProblemOf } from './treatments-model';
import type { TreatmentProblem } from './treatments-model';

export interface DeleteTreatmentDialogProps {
  readonly risk: RiskDto;
  /** Ação a excluir (`null` = fechado); sempre a versão mais recente da lista. */
  readonly treatment: RiskTreatmentDto | null;
  readonly onClose: () => void;
  readonly onChanged: () => Promise<void> | void;
}

/**
 * `DeleteTreatmentDialog` (US-034 · fluxo principal, passo 9 · RN-RISK-17): confirma a exclusão
 * lógica e sugere cancelar para manter o histórico (FA-01). 412 recarrega e avisa; 403/409 mostram o
 * motivo; 503 mantém o diálogo para tentar de novo.
 */
export function DeleteTreatmentDialog({
  risk,
  treatment,
  onClose,
  onChanged,
}: DeleteTreatmentDialogProps) {
  const t = useTranslations('risks.treatments');
  const [problem, setProblem] = useState<TreatmentProblem | null>(null);
  const close = () => {
    setProblem(null);
    onClose();
  };

  const remove = useMutation({
    mutationFn: (target: RiskTreatmentDto) => deleteTreatment(target.id, target.version),
    onSuccess: async () => {
      toast({ title: t('toast.removed'), tone: 'success' });
      close();
      await onChanged();
    },
    onError: (error: unknown) => {
      const found = treatmentProblemOf(error);
      if (found.kind === 'stale' || found.kind === 'notFound') {
        toast({ title: treatmentProblemMessage(found) ?? '', tone: 'error' });
        void onChanged();
        close();
        return;
      }
      if (found.kind === 'permission' || found.kind === 'blocked') void onChanged();
      setProblem(found);
    },
  });

  const message = problem === null ? null : treatmentProblemMessage(problem);
  return (
    <Dialog
      open={treatment !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent closeLabel={null}>
        <DialogTitle>{t('remove.title')}</DialogTitle>
        <DialogDescription>{t('remove.description', { code: risk.code })}</DialogDescription>
        {treatment === null ? null : (
          <p className="rounded-control border border-border p-2 text-sm">
            <span className="font-medium">{TREATMENT_TYPE_LABELS[treatment.type]}</span>
            <span className="block break-words">{treatment.description}</span>
          </p>
        )}
        <div aria-live="polite">
          {message !== null ? <Alert tone="error" title={message} /> : null}
          {problem?.kind === 'unexpected' ? (
            <Alert
              tone="error"
              title={t('toast.unexpected', { correlationId: problem.correlationId })}
            />
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={close}>
            {t('remove.cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => {
              setProblem(null);
              if (treatment !== null) remove.mutate(treatment);
            }}
          >
            {problem?.kind === 'unavailable' ? t('remove.retry') : t('remove.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
