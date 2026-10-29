'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Field,
  Textarea,
} from '@contrataflow/ui';
import { deleteAttachmentSchema } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';

export interface DeleteAttachmentDialogProps {
  /** Nome do arquivo a excluir; `null` = fechado. */
  readonly fileName: string | null;
  readonly onConfirm: (reason: string) => Promise<void>;
  readonly onClose: () => void;
}

/**
 * `DeleteAttachmentDialog` (US-068 · RN-DOC-79 · V-07): motivo obrigatório (a regra do
 * `deleteAttachmentSchema` da API), foco inicial no campo, erro ligado por `aria-describedby` e
 * falha do envio em alerta com nova tentativa.
 */
export function DeleteAttachmentDialog({
  fileName,
  onConfirm,
  onClose,
}: DeleteAttachmentDialogProps) {
  return (
    <Dialog
      open={fileName !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent role="alertdialog">
        {fileName === null ? null : (
          <Body key={fileName} fileName={fileName} onConfirm={onConfirm} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Body({
  fileName,
  onConfirm,
  onClose,
}: {
  readonly fileName: string;
  readonly onConfirm: (reason: string) => Promise<void>;
  readonly onClose: () => void;
}) {
  const t = useTranslations('attachments.delete');
  const field = useRef<HTMLTextAreaElement>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);

  const confirm = async () => {
    const parsed = deleteAttachmentSchema.safeParse({ deletionReason: reason });
    if (!parsed.success) {
      setError(t('required'));
      field.current?.focus();
      return;
    }
    setError(null);
    setFailed(false);
    setPending(true);
    try {
      await onConfirm(parsed.data.deletionReason);
      onClose();
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <DialogTitle>{t('title')}</DialogTitle>
      <DialogDescription>{t('description', { fileName })}</DialogDescription>
      <Field label={t('label')} required error={error}>
        <Textarea
          ref={field}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- foco inicial do diálogo no campo obrigatório
          autoFocus
          rows={3}
          value={reason}
          maxLength={1000}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </Field>
      {failed ? <Alert tone="error" title={t('failed')} /> : null}
      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={pending}>
          {t('cancel')}
        </Button>
        <Button
          variant="destructive"
          disabled={pending}
          onClick={() => {
            void confirm();
          }}
        >
          {pending ? t('working') : t('confirm')}
        </Button>
      </DialogFooter>
    </>
  );
}
