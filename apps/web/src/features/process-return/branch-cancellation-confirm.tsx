'use client';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@contrataflow/ui';
import { useTranslations } from 'next-intl';

export interface BranchCancellationConfirmProps {
  readonly open: boolean;
  /** Reenvia a mesma devolução com `confirmBranchCancellation: true`. */
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly submitting?: boolean | undefined;
}

/**
 * `BranchCancellationConfirm` (US-124 · RN-WF2-23): devolver de um ramo para antes da ramificação
 * cancela os outros ramos e as aprovações pendentes. O PRC-20 recusa com 422
 * `BRANCH_CANCELLATION_NOT_CONFIRMED`; este diálogo (foco preso pelo Radix) explica o efeito e, ao
 * confirmar, quem o abriu reenvia a mesma devolução, mantendo o comentário digitado.
 */
export function BranchCancellationConfirm({
  open,
  onConfirm,
  onCancel,
  submitting = false,
}: BranchCancellationConfirmProps) {
  const t = useTranslations('processes.return.branchCancellation');
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !submitting) onCancel();
      }}
    >
      <DialogContent closeLabel={null} role="alertdialog">
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
        <DialogFooter>
          <Button type="button" variant="secondary" disabled={submitting} onClick={onCancel}>
            {t('cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            aria-disabled={submitting ? true : undefined}
            onClick={() => {
              if (!submitting) onConfirm();
            }}
          >
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
