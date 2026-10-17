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

import type { DocumentOutcome } from './document-errors';
import { OutcomeAlert } from './outcome-alert';
import { useReturnFocus } from './use-return-focus';

export interface DeleteDraftDialogProps {
  readonly open: boolean;
  readonly pending: boolean;
  readonly feedback: DocumentOutcome | null;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
  /** Padrão do Radix: o foco volta a quem abriu o diálogo. Quem controla o foco passa o seu. */
  readonly onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

/**
 * Confirmação da exclusão do rascunho (DOC-14): `alertdialog` simples, sem justificativa. Depois do
 * 204 a tela volta ao painel do processo, aba "Documentos" (a navegação é de quem executa).
 */
export function DeleteDraftDialog({
  open,
  pending,
  feedback,
  onConfirm,
  onClose,
  onCloseAutoFocus,
}: DeleteDraftDialogProps) {
  const t = useTranslations('documents.delete');
  const returnFocus = useReturnFocus(onCloseAutoFocus);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogContent
        role="alertdialog"
        onOpenAutoFocus={returnFocus.remember}
        onCloseAutoFocus={returnFocus.restore}
      >
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
        <div aria-live="assertive">
          {feedback ? <OutcomeAlert outcome={feedback} onRetry={onConfirm} /> : null}
        </div>
        <DialogFooter>
          <Button variant="secondary" disabled={pending} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="destructive" disabled={pending} aria-busy={pending} onClick={onConfirm}>
            {pending ? t('working') : t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
