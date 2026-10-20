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
import type { TenantMembershipDto } from '@contrataflow/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { useTenantId } from '@/lib/session/session-context';

import { cancelInvitation, userKeys } from './users.api';

export interface CancelInvitationDialogProps {
  /** Convite a cancelar; `null` fecha o diálogo. */
  readonly invitation: TenantMembershipDto | null;
  readonly onClose: () => void;
}

/** Confirmação do cancelamento do convite (USR-05): `role="alertdialog"`, erro anunciado. */
export function CancelInvitationDialog({ invitation, onClose }: CancelInvitationDialogProps) {
  return (
    <Dialog
      open={invitation !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent role="alertdialog">
        {invitation ? <Body key={invitation.id} invitation={invitation} onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function Body({
  invitation,
  onClose,
}: {
  readonly invitation: TenantMembershipDto;
  readonly onClose: () => void;
}) {
  const t = useTranslations('users');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const cancel = useMutation({
    mutationFn: () => cancelInvitation(invitation.userId),
    onSuccess: () => {
      toast({ title: t('toast.cancelled', { name: invitation.name }), tone: 'success' });
      void queryClient.invalidateQueries({ queryKey: userKeys.all(tenantId) });
      onClose();
    },
    onError: (failure) => {
      if (!isApiError(failure)) setError(t('errors.generic'));
      else if (failure.code === 'INVALID_STATE') setError(t('errors.invalidState'));
      else if (failure.status === 404) setError(t('errors.notFound'));
      else if (failure.status === 403) setError(t('errors.permission'));
      else if (failure.status === 503) setError(t('errors.actionUnavailable'));
      else setError(failure.message || t('errors.generic'));
      if (isApiError(failure) && (failure.code === 'INVALID_STATE' || failure.status === 404)) {
        void queryClient.invalidateQueries({ queryKey: userKeys.all(tenantId) });
      }
    },
  });

  return (
    <>
      <DialogTitle>{t('cancelDialog.title', { name: invitation.name })}</DialogTitle>
      <DialogDescription>
        {t('cancelDialog.description', { email: invitation.email })}
      </DialogDescription>
      <div aria-live="assertive">{error ? <Alert tone="error" title={error} /> : null}</div>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          {t('cancelDialog.keep')}
        </Button>
        <Button
          variant="destructive"
          disabled={cancel.isPending}
          aria-busy={cancel.isPending}
          onClick={() => {
            setError(null);
            cancel.mutate();
          }}
        >
          {t('cancelDialog.confirm')}
        </Button>
      </DialogFooter>
    </>
  );
}
