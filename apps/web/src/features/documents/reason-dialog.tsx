'use client';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@contrataflow/ui';
import { DOCUMENT_LIMITS, DOCUMENT_MESSAGES, documentReasonSchema } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import type { RefObject } from 'react';

import type { DocumentOutcome } from './document-errors';
import { OutcomeAlert } from './outcome-alert';
import { useReturnFocus } from './use-return-focus';

export interface ReasonDialogProps {
  readonly open: boolean;
  readonly pending: boolean;
  /** Falha do último envio: mensagem de campo (422) ou alerta em linha (503, inesperado). */
  readonly feedback: DocumentOutcome | null;
  readonly onSubmit: (reason: string) => void;
  readonly onRetry: () => void;
  readonly onClose: () => void;
  /** Padrão do Radix: o foco volta a quem abriu o diálogo. Quem controla o foco passa o seu. */
  readonly onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

interface ReasonCopy {
  readonly title: string;
  readonly description: string;
  readonly label: string;
  readonly confirm: string;
  readonly cancel: string;
  readonly working: string;
  readonly hint: string;
  /** Contador "n de 2.000 caracteres" (vira texto a cada digitação). */
  readonly count: (count: number) => string;
}

/**
 * Diálogo com justificativa obrigatória (RN-DOC-47/48 · V-03): mínimo de 20 caracteres, contador,
 * `aria-describedby` ligando o campo à ajuda, ao contador e ao erro, foco inicial no campo e foco
 * devolvido ao fechar. A regra é a do `documentReasonSchema` da API (a mensagem também).
 */
function ReasonDialog({
  open,
  pending,
  feedback,
  copy,
  destructive,
  onSubmit,
  onRetry,
  onClose,
  onCloseAutoFocus,
}: ReasonDialogProps & { readonly copy: ReasonCopy; readonly destructive: boolean }) {
  const field = useRef<HTMLTextAreaElement>(null);
  const returnFocus = useReturnFocus(onCloseAutoFocus);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogContent
        onOpenAutoFocus={(event) => {
          returnFocus.remember();
          event.preventDefault();
          field.current?.focus();
        }}
        onCloseAutoFocus={returnFocus.restore}
      >
        <ReasonBody
          copy={copy}
          field={field}
          destructive={destructive}
          pending={pending}
          feedback={feedback}
          onSubmit={onSubmit}
          onRetry={onRetry}
          onClose={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}

function ReasonBody({
  copy,
  field,
  destructive,
  pending,
  feedback,
  onSubmit,
  onRetry,
  onClose,
}: Pick<ReasonDialogProps, 'pending' | 'feedback' | 'onSubmit' | 'onRetry' | 'onClose'> & {
  readonly copy: ReasonCopy;
  readonly field: RefObject<HTMLTextAreaElement | null>;
  readonly destructive: boolean;
}) {
  const id = useId();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const serverError = feedback?.kind === 'field' ? feedback.message : null;
  const shownError = error ?? serverError;
  const inline = feedback && feedback.kind !== 'field' ? feedback : null;

  const confirm = () => {
    const parsed = documentReasonSchema.safeParse(reason);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? DOCUMENT_MESSAGES.reasonTooShort);
      field.current?.focus();
      return;
    }
    setError(null);
    onSubmit(parsed.data);
  };

  const describedBy = [`${id}-hint`, `${id}-count`, shownError ? `${id}-error` : null]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <DialogTitle>{copy.title}</DialogTitle>
      <DialogDescription>{copy.description}</DialogDescription>

      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-field`} className="text-sm font-medium">
          {copy.label}
        </label>
        <textarea
          id={`${id}-field`}
          ref={field}
          rows={4}
          required
          className="rounded-control border border-border bg-surface px-3 py-2 text-sm"
          value={reason}
          aria-invalid={shownError !== null}
          aria-describedby={describedBy}
          onChange={(event) => {
            setReason(event.target.value);
            setError(null);
          }}
        />
        <div className="flex flex-wrap justify-between gap-x-4 text-xs text-muted-foreground">
          <p id={`${id}-hint`}>{copy.hint}</p>
          <p id={`${id}-count`}>{copy.count(reason.trim().length)}</p>
        </div>
        {shownError ? (
          <p id={`${id}-error`} className="text-sm text-destructive">
            {shownError}
          </p>
        ) : null}
      </div>

      <div aria-live="assertive">
        {inline ? <OutcomeAlert outcome={inline} onRetry={onRetry} /> : null}
      </div>

      <DialogFooter>
        <Button variant="secondary" disabled={pending} onClick={onClose}>
          {copy.cancel}
        </Button>
        <Button
          variant={destructive ? 'destructive' : 'primary'}
          disabled={pending}
          aria-busy={pending}
          onClick={confirm}
        >
          {pending ? copy.working : copy.confirm}
        </Button>
      </DialogFooter>
    </>
  );
}

function useReasonCopy(kind: 'reopen' | 'cancel'): ReasonCopy {
  const t = useTranslations('documents.reason');
  return {
    title: t(`${kind}.title`),
    description: t(`${kind}.description`),
    label: t(`${kind}.label`),
    confirm: t(`${kind}.confirm`),
    cancel: t(`${kind}.cancel`),
    working: t('working'),
    hint: t('hint', { min: DOCUMENT_LIMITS.reasonMin }),
    count: (count) => t('count', { count, max: DOCUMENT_LIMITS.reasonMax }),
  };
}

/** `ReopenDialog` (DOC-12 · POL-11): justificativa da reabertura. */
export function ReopenDialog(props: ReasonDialogProps) {
  const copy = useReasonCopy('reopen');
  return <ReasonDialog {...props} copy={copy} destructive={false} />;
}

/** `CancelDialog` (DOC-13): motivo do cancelamento, que é definitivo. */
export function CancelDialog(props: ReasonDialogProps) {
  const copy = useReasonCopy('cancel');
  return <ReasonDialog {...props} copy={copy} destructive />;
}
