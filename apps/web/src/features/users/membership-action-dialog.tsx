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
import { MEMBERSHIP_REASON_MAX, membershipReasonSchema } from '@contrataflow/validation';
import type { TenantMembershipDetailDto } from '@contrataflow/validation';
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { stepUpHref } from '@/lib/api/error-policy';

import { describeUserError } from './user-errors';
import type { UserFeedback } from './user-errors';
import { revokeUser, suspendUser } from './users.api';
import type { UserDetailResult } from './users.api';

export type MembershipDialogAction = 'SUSPEND' | 'REVOKE';

export interface MembershipActionDialogProps {
  /** Ação a confirmar; `null` fecha o diálogo. */
  readonly action: MembershipDialogAction | null;
  readonly membership: TenantMembershipDetailDto;
  readonly returnTo: string;
  readonly onClose: () => void;
  readonly onDone: (action: MembershipDialogAction, result: UserDetailResult) => void;
  /** Erro que deixa o detalhe velho (412, 409 `INVALID_STATE`, 404): a tela recarrega. */
  readonly onStale: (feedback: UserFeedback) => void;
}

/**
 * `ConfirmDialog` de suspender (USR-10) e revogar (USR-12) com motivo opcional (≤ 500): `role=
 * "alertdialog"`; a revogação avisa que é irreversível. Erros recuperáveis (503, política, MFA)
 * ficam no diálogo; os que deixam o detalhe velho fecham o diálogo e a tela recarrega.
 */
export function MembershipActionDialog(props: MembershipActionDialogProps) {
  const { action, onClose } = props;
  return (
    <Dialog
      open={action !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent role="alertdialog">
        {action ? <Body key={action} {...props} action={action} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function Body({
  action,
  membership,
  returnTo,
  onClose,
  onDone,
  onStale,
}: MembershipActionDialogProps & { readonly action: MembershipDialogAction }) {
  const t = useTranslations('users.detail');
  const tErrors = useTranslations('users.detail.errors');
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<UserFeedback | null>(null);
  const revoke = action === 'REVOKE';

  const run = useMutation({
    mutationFn: (body: Parameters<typeof suspendUser>[1]) =>
      (revoke ? revokeUser : suspendUser)(membership.userId, body, membership.version),
    onSuccess: (result) => {
      onDone(action, result);
    },
    onError: (error) => {
      const described = describeUserError(error, tErrors);
      if (described.kind === 'stale' || described.kind === 'notFound') {
        onStale(described);
        onClose();
        return;
      }
      if (described.kind === 'validation' && isApiError(error)) {
        const fieldError = error.errors.find((item) => item.field === 'reason');
        if (fieldError) {
          setReasonError(fieldError.message);
          document.getElementById(reasonId)?.focus();
          return;
        }
      }
      setFeedback(described);
    },
  });

  const confirm = () => {
    const text = reason.trim();
    const parsed = membershipReasonSchema.safeParse({ reason: text === '' ? null : text });
    if (!parsed.success) {
      setReasonError(parsed.error.issues[0]?.message ?? null);
      document.getElementById(reasonId)?.focus();
      return;
    }
    setReasonError(null);
    setFeedback(null);
    run.mutate(text === '' ? {} : { reason: text });
  };

  const retrying = feedback?.kind === 'unavailable';
  const key = revoke ? 'Revoke' : 'Suspend';
  return (
    <>
      <DialogTitle>
        {t(`dialog.${revoke ? 'revokeTitle' : 'suspendTitle'}`, { name: membership.name })}
      </DialogTitle>
      <DialogDescription>
        {t(`dialog.${revoke ? 'revokeDescription' : 'suspendDescription'}`)}
      </DialogDescription>
      {revoke ? <Alert tone="warning" live={false} title={t('dialog.revokeWarning')} /> : null}

      <div className="flex flex-col gap-1">
        <label htmlFor={reasonId} className="text-sm font-medium">
          {t('dialog.reason')}
        </label>
        <textarea
          id={reasonId}
          rows={3}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- foco no primeiro campo do diálogo
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
          {t('dialog.reasonHint', { max: MEMBERSHIP_REASON_MAX })}
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
            {feedback.hint ? <p className="text-sm">{feedback.hint}</p> : null}
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
          {t('dialog.cancel')}
        </Button>
        <Button
          variant="destructive"
          disabled={run.isPending}
          aria-busy={run.isPending}
          onClick={confirm}
        >
          {run.isPending
            ? t('dialog.working')
            : retrying
              ? tErrors('retry')
              : t(`dialog.confirm${key}`)}
        </Button>
      </DialogFooter>
    </>
  );
}
