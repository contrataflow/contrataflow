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
import { ROLE_ASSIGNMENT_REASON_MAX, revokeRoleAssignmentSchema } from '@contrataflow/validation';
import type { RoleAssignmentDto } from '@contrataflow/validation';
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { stepUpHref } from '@/lib/api/error-policy';

import { revokeRoleAssignment } from './role-assignments.api';

export interface ConfirmRevokeDialogProps {
  /** Atribuição a revogar; `null` fecha o diálogo. */
  readonly assignment: RoleAssignmentDto | null;
  readonly returnTo: string;
  readonly onClose: () => void;
  readonly onRevoked: (assignment: RoleAssignmentDto) => void;
  /** 404/409/412: a lista ficou velha — a tela recarrega. */
  readonly onStale: (message: string) => void;
}

/**
 * `ConfirmRevokeDialog` (SCR-029 · US-096 · ROL-12): motivo opcional (≤ 500), `role="alertdialog"`.
 * POL-12 (409 `LAST_ADMIN_REQUIRED`) fica no diálogo com a sugestão de atribuir outro
 * administrador antes (FA-04).
 */
export function ConfirmRevokeDialog(props: ConfirmRevokeDialogProps) {
  const { assignment, onClose } = props;
  return (
    <Dialog
      open={assignment !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent role="alertdialog">
        {assignment ? <Body key={assignment.id} {...props} assignment={assignment} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function Body({
  assignment,
  returnTo,
  onClose,
  onRevoked,
  onStale,
}: ConfirmRevokeDialogProps & { readonly assignment: RoleAssignmentDto }) {
  const t = useTranslations('users.detail.roles');
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [failure, setFailure] = useState<{
    message: string;
    hint?: string;
    mfa?: boolean;
  } | null>(null);

  const run = useMutation({
    mutationFn: (text: string | null) => revokeRoleAssignment(assignment, text),
    onSuccess: (result) => {
      onRevoked(result.data);
    },
    onError: (error) => {
      if (!isApiError(error)) {
        setFailure({ message: t('errors.generic') });
        return;
      }
      if (error.status === 404 || error.status === 412 || error.code === 'INVALID_STATE') {
        onStale(t('errors.stale'));
        onClose();
        return;
      }
      if (error.code === 'LAST_ADMIN_REQUIRED') {
        setFailure({ message: error.message, hint: t('errors.lastAdminHint') });
        return;
      }
      const field = error.errors.find((item) => item.field === 'reason');
      if (field) {
        setReasonError(field.message);
        return;
      }
      setFailure({
        message: error.message || t('errors.generic'),
        mfa: error.code === 'MFA_REQUIRED',
      });
    },
  });

  const confirm = () => {
    const text = reason.trim();
    const parsed = revokeRoleAssignmentSchema.safeParse({ reason: text === '' ? null : text });
    if (!parsed.success) {
      setReasonError(parsed.error.issues[0]?.message ?? null);
      document.getElementById(reasonId)?.focus();
      return;
    }
    setReasonError(null);
    setFailure(null);
    run.mutate(text === '' ? null : text);
  };

  return (
    <>
      <DialogTitle>{t('revokeTitle', { role: assignment.roleName })}</DialogTitle>
      <DialogDescription>{t('revokeDescription', { name: assignment.userName })}</DialogDescription>

      <Field
        label={t('reason')}
        id={reasonId}
        description={t('reasonHint', { max: ROLE_ASSIGNMENT_REASON_MAX })}
        error={reasonError ?? undefined}
      >
        <Textarea
          rows={3}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- foco no primeiro campo do diálogo
          autoFocus
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            setReasonError(null);
          }}
        />
      </Field>

      <div aria-live="assertive">
        {failure ? (
          <Alert tone="error" title={failure.message}>
            {failure.hint ? <p className="text-sm">{failure.hint}</p> : null}
            {failure.mfa ? (
              <a className="font-medium underline" href={stepUpHref(returnTo)}>
                {t('errors.stepUp')}
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
          {run.isPending ? t('revoking') : t('confirmRevoke')}
        </Button>
      </DialogFooter>
    </>
  );
}
