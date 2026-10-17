'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@contrataflow/ui';
import {
  MEMBERSHIP_REASON_MAX,
  MFA_RESET_REASON_MIN,
  mfaResetSchema,
} from '@contrataflow/validation';
import type { MfaResetResult, TenantMembershipDetailDto } from '@contrataflow/validation';
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { stepUpHref } from '@/lib/api/error-policy';

import { describeUserError } from './user-errors';
import type { UserFeedback } from './user-errors';
import { resetUserMfa } from './users.api';

export interface MfaResetDialogProps {
  readonly open: boolean;
  readonly membership: TenantMembershipDetailDto;
  readonly returnTo: string;
  readonly onClose: () => void;
  readonly onDone: (result: MfaResetResult) => void;
  /** 404 (usuário saiu do tenant) ou 409 `INVALID_STATE` (revogado): a tela recarrega. */
  readonly onStale: (feedback: UserFeedback) => void;
}

/**
 * `MfaResetDialog` (SCR-029 · US-090 · USR-13): motivo obrigatório (10–500, V-03) e confirmação,
 * com foco no motivo. Erros recuperáveis ficam no diálogo: 503 com "Tentar novamente", 403
 * `MFA_REQUIRED` com o link de *step-up* do próprio administrador, 422 no campo do motivo ou,
 * sobre o próprio vínculo (`NOT_ALLOWED`), a orientação de usar a recuperação no login.
 */
export function MfaResetDialog(props: MfaResetDialogProps) {
  const { open, onClose } = props;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent role="alertdialog">{open ? <Body {...props} /> : null}</DialogContent>
    </Dialog>
  );
}

function Body({ membership, returnTo, onClose, onDone, onStale }: MfaResetDialogProps) {
  const t = useTranslations('users.detail.mfa');
  const tErrors = useTranslations('users.detail.errors');
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<UserFeedback | null>(null);

  const run = useMutation({
    mutationFn: (text: string) => resetUserMfa(membership.userId, { reason: text }),
    onSuccess: (result) => {
      onDone(result);
    },
    onError: (error) => {
      const described = describeUserError(error, tErrors);
      if (described.kind === 'stale' || described.kind === 'notFound') {
        onStale(described);
        onClose();
        return;
      }
      if (isApiError(error) && error.status === 422) {
        const fieldError = error.errors.find((item) => item.field === 'reason');
        if (fieldError) {
          setReasonError(fieldError.message);
          document.getElementById(reasonId)?.focus();
          return;
        }
        if (error.errors.some((item) => item.code === 'NOT_ALLOWED')) {
          setFeedback({ kind: 'plain', message: t('self') });
          return;
        }
      }
      if (described.kind === 'unavailable') {
        setFeedback({ kind: 'unavailable', message: t('unavailable') });
        return;
      }
      if (isApiError(error) && error.code === 'PERMISSION_DENIED') {
        setFeedback({ kind: 'plain', message: t('permission') });
        return;
      }
      setFeedback(described);
    },
  });

  const confirm = () => {
    const parsed = mfaResetSchema.safeParse({ reason });
    if (!parsed.success) {
      setReasonError(parsed.error.issues[0]?.message ?? null);
      document.getElementById(reasonId)?.focus();
      return;
    }
    setReasonError(null);
    setFeedback(null);
    run.mutate(parsed.data.reason);
  };

  const retrying = feedback?.kind === 'unavailable';
  return (
    <>
      <DialogTitle>{t('dialogTitle', { name: membership.name })}</DialogTitle>
      <DialogDescription>{t('dialogDescription')}</DialogDescription>

      <div className="flex flex-col gap-1">
        <label htmlFor={reasonId} className="text-sm font-medium">
          {t('reason')}
        </label>
        <textarea
          id={reasonId}
          rows={3}
          required
          // eslint-disable-next-line jsx-a11y/no-autofocus -- foco no motivo, o único campo
          autoFocus
          className="rounded-control border border-border bg-surface px-3 py-2 text-sm"
          value={reason}
          aria-invalid={reasonError !== null}
          aria-describedby={`${reasonId}-hint${reasonError ? ` ${reasonId}-error` : ''}`}
          onChange={(event) => {
            setReason(event.target.value);
            setReasonError(null);
          }}
        />
        <p id={`${reasonId}-hint`} className="text-xs text-muted-foreground">
          {t('reasonHint', { min: MFA_RESET_REASON_MIN, max: MEMBERSHIP_REASON_MAX })}
        </p>
        {reasonError ? (
          <p id={`${reasonId}-error`} className="text-sm text-destructive">
            {reasonError}
          </p>
        ) : null}
      </div>

      <div aria-live="assertive">
        {feedback ? (
          <Alert tone="error" title={feedback.message}>
            {feedback.kind === 'mfa' ? (
              <a className="font-medium underline" href={stepUpHref(returnTo)}>
                {tErrors('stepUp')}
              </a>
            ) : null}
          </Alert>
        ) : null}
      </div>

      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button
          variant="destructive"
          disabled={run.isPending}
          aria-busy={run.isPending}
          onClick={confirm}
        >
          {run.isPending ? t('working') : retrying ? tErrors('retry') : t('confirm')}
        </Button>
      </DialogFooter>
    </>
  );
}
