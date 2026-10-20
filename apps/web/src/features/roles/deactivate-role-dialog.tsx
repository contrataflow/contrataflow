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
import type { RoleDto } from '@contrataflow/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { permissionKeys } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

import { deactivateRole, roleKeys } from './roles.api';

export interface DeactivateRoleDialogProps {
  /** Perfil a desativar; `null` fecha o diálogo. */
  readonly role: RoleDto | null;
  readonly onClose: () => void;
}

/**
 * `DeactivateRoleDialog` (SCR-030/031 · FA-04): confirma a desativação mostrando quantos vínculos
 * ativos usam o perfil; com vínculos, exige a confirmação explícita (`confirmDeactivate`). O
 * resultado é anunciado em `aria-live`.
 */
export function DeactivateRoleDialog({ role, onClose }: DeactivateRoleDialogProps) {
  return (
    <Dialog
      open={role !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        {role ? <Body key={role.id} role={role} onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function Body({ role, onClose }: { readonly role: RoleDto; readonly onClose: () => void }) {
  const t = useTranslations('roles');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const confirmId = useId();
  const affected = role.activeAssignmentsCount;
  const [confirmed, setConfirmed] = useState(affected === 0);
  const [error, setError] = useState<string | null>(null);

  const deactivate = useMutation({
    mutationFn: () => deactivateRole(role.id, role.version, affected > 0),
    onSuccess: (result) => {
      toast({ title: t('toast.deactivated', { name: result.data.name }), tone: 'success' });
      void queryClient.invalidateQueries({ queryKey: roleKeys.all(tenantId) });
      void queryClient.invalidateQueries({ queryKey: permissionKeys.all(tenantId) });
      onClose();
    },
    onError: (failure) => {
      if (!isApiError(failure)) setError(t('errors.generic'));
      else if (failure.code === 'LAST_ADMIN_REQUIRED') setError(t('deactivate.adminBlocked'));
      else if (failure.status === 412) setError(t('errors.conflict'));
      else if (failure.status === 403) setError(t('errors.permission'));
      else if (failure.status === 503) setError(t('errors.unavailable'));
      else setError(failure.message || t('errors.generic'));
      void queryClient.invalidateQueries({ queryKey: roleKeys.all(tenantId) });
    },
  });

  return (
    <>
      <DialogTitle>{t('deactivate.title', { name: role.name })}</DialogTitle>
      <DialogDescription>{t('deactivate.description')}</DialogDescription>
      <p className="text-sm font-medium">
        {affected > 0
          ? t('deactivate.affected', { count: affected })
          : t('deactivate.noneAffected')}
      </p>
      {affected > 0 ? (
        <div className="flex items-start gap-2">
          <input
            id={confirmId}
            type="checkbox"
            className="mt-1 h-4 w-4"
            checked={confirmed}
            onChange={(event) => {
              setConfirmed(event.target.checked);
            }}
          />
          <label htmlFor={confirmId} className="text-sm">
            {t('deactivate.confirmAffected', { count: affected })}
          </label>
        </div>
      ) : null}
      <div aria-live="assertive">{error ? <Alert tone="error" title={error} /> : null}</div>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          {t('deactivate.cancel')}
        </Button>
        <Button
          variant="destructive"
          disabled={!confirmed || deactivate.isPending}
          aria-busy={deactivate.isPending}
          onClick={() => {
            setError(null);
            deactivate.mutate();
          }}
        >
          {t('deactivate.confirm')}
        </Button>
      </DialogFooter>
    </>
  );
}
