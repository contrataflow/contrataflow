'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  toast,
} from '@contrataflow/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useState } from 'react';
import type { SyntheticEvent } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { stepUpHref } from '@/lib/api/error-policy';
import { useIdempotentMutation } from '@/lib/api/use-idempotent-mutation';
import { useTenantId } from '@/lib/session/session-context';

import { DepartmentMultiSelect } from './department-multi-select';
import {
  EMPTY_INVITE_FORM,
  firstInviteErrorField,
  inviteFieldOf,
  todayLocalDate,
  validateInvite,
} from './invite-form-model';
import type { InviteField, InviteFieldErrors, InviteFormState } from './invite-form-model';
import { LOOKUP_STALE_TIME_MS, fetchActiveRoles, inviteUser, userKeys } from './users.api';

const INPUT = 'h-10 rounded-control border border-border bg-surface px-3 text-sm';

export interface InviteUserFormProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Rota de retorno do *step-up* de MFA. */
  readonly returnTo: string;
}

/**
 * `InviteUserForm` (SCR-029 · US-091 · USR-03): e-mail, nome, tipo de vínculo, cargo, validade
 * (só `EXTERNAL`), lotação e perfil inicial, validados com o `inviteUserSchema` da API. Erros 422
 * vão para os campos e o foco para o primeiro; 409 sugere reenviar o convite existente; 503 e
 * demais falhas mantêm o que foi digitado.
 */
export function InviteUserForm(props: InviteUserFormProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent style={{ maxWidth: '40rem', maxHeight: '90vh', overflowY: 'auto' }}>
        {props.open ? <InviteUserBody {...props} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function InviteUserBody({ onOpenChange, returnTo }: InviteUserFormProps) {
  const t = useTranslations('users');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const ids = useId();
  const [form, setForm] = useState<InviteFormState>(EMPTY_INVITE_FORM);
  const [errors, setErrors] = useState<InviteFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [alreadyMember, setAlreadyMember] = useState(false);
  const [needsMfa, setNeedsMfa] = useState(false);
  const [focusRequest, setFocusRequest] = useState<{ field: InviteField; n: number } | null>(null);

  const idOf = (field: InviteField) => `${ids}-${field}`;
  const errorIdOf = (field: InviteField) => `${ids}-${field}-error`;

  const roles = useQuery({
    queryKey: userKeys.activeRoles(tenantId),
    queryFn: async ({ signal }) => (await fetchActiveRoles(signal)).data,
    staleTime: LOOKUP_STALE_TIME_MS,
    retry: false,
    // Sem `ROLE_VIEW` (403) o campo some; falha ao ler perfis não derruba o formulário.
    throwOnError: false,
  });
  const assignableRoles = (roles.data ?? []).filter(
    (role) => role.isActive && (form.type === 'INTERNAL' || role.allowExternalAssignment),
  );

  const create = useIdempotentMutation({
    mutationFn: (body: Parameters<typeof inviteUser>[0], context) =>
      inviteUser(body, context.idempotencyKey, context.correlationId),
  });

  useEffect(() => {
    if (!focusRequest) return;
    document.getElementById(idOf(focusRequest.field))?.focus();
    // `idOf` só depende de `ids` (estável).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  const fail = (next: InviteFieldErrors, general: string | null = null) => {
    setErrors(next);
    setFormError(general);
    const field = firstInviteErrorField(next);
    if (field) setFocusRequest((current) => ({ field, n: (current?.n ?? 0) + 1 }));
  };

  const update = <K extends keyof InviteFormState>(key: K, value: InviteFormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const applyApiError = (error: unknown): void => {
    let fieldErrors: InviteFieldErrors = {};
    let general: string | null = null;
    if (!isApiError(error)) {
      general = t('errors.generic');
    } else if (error.code === 'MEMBERSHIP_ALREADY_EXISTS') {
      setAlreadyMember(true);
      fieldErrors = { email: t('form.alreadyMember') };
    } else if (error.code === 'MFA_REQUIRED') {
      setNeedsMfa(true);
      general = t('errors.mfa');
    } else if (error.status === 403) {
      general = t('errors.permission');
    } else if (error.status === 503) {
      general = t('errors.unavailable');
    } else if (error.status === 422) {
      for (const item of error.errors) {
        const field = inviteFieldOf(item.field);
        if (field) fieldErrors[field] ??= item.message;
        else general ??= item.message;
      }
      if (Object.keys(fieldErrors).length === 0) general ??= error.message;
    } else {
      general = error.message || t('errors.generic');
    }
    fail(fieldErrors, general);
  };

  const onSubmit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAlreadyMember(false);
    setNeedsMfa(false);
    const validation = validateInvite(form);
    if (!validation.ok) {
      fail(validation.errors, validation.formError);
      return;
    }
    setErrors({});
    setFormError(null);
    try {
      const result = await create.submit(validation.data);
      toast({ title: t('toast.invited', { email: result.data.email }), tone: 'success' });
      void queryClient.invalidateQueries({ queryKey: userKeys.all(tenantId) });
      onOpenChange(false);
    } catch (error: unknown) {
      applyApiError(error);
    }
  };

  const fieldError = (field: InviteField) =>
    errors[field] ? (
      <p id={errorIdOf(field)} className="text-sm text-destructive">
        {errors[field]}
      </p>
    ) : null;
  const describedBy = (field: InviteField, extra?: string) =>
    [extra, errors[field] ? errorIdOf(field) : undefined].filter(Boolean).join(' ') || undefined;

  return (
    <form
      noValidate
      onSubmit={(event) => {
        void onSubmit(event);
      }}
      className="flex flex-col gap-4"
    >
      <DialogTitle>{t('form.title')}</DialogTitle>
      <DialogDescription>{t('form.description')}</DialogDescription>

      <div className="flex flex-col gap-1">
        <label htmlFor={idOf('email')} className="text-sm font-medium">
          {t('form.email')}
        </label>
        <input
          id={idOf('email')}
          type="email"
          autoComplete="off"
          // eslint-disable-next-line jsx-a11y/no-autofocus -- foco no primeiro campo ao abrir o diálogo
          autoFocus
          className={INPUT}
          value={form.email}
          aria-invalid={errors.email !== undefined}
          aria-describedby={describedBy('email')}
          onChange={(event) => {
            update('email', event.target.value);
          }}
        />
        {fieldError('email')}
        {alreadyMember ? (
          <p className="text-sm text-muted-foreground">{t('form.alreadyMemberHint')}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={idOf('name')} className="text-sm font-medium">
          {t('form.name')}
        </label>
        <input
          id={idOf('name')}
          autoComplete="off"
          maxLength={200}
          className={INPUT}
          value={form.name}
          aria-invalid={errors.name !== undefined}
          aria-describedby={describedBy('name')}
          onChange={(event) => {
            update('name', event.target.value);
          }}
        />
        {fieldError('name')}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={idOf('type')} className="text-sm font-medium">
          {t('form.type')}
        </label>
        <select
          id={idOf('type')}
          className={INPUT}
          value={form.type}
          aria-invalid={errors.type !== undefined}
          aria-describedby={describedBy('type')}
          onChange={(event) => {
            const type = event.target.value === 'EXTERNAL' ? 'EXTERNAL' : 'INTERNAL';
            setForm((current) => {
              const role = roles.data?.find((item) => item.id === current.roleId);
              return {
                ...current,
                type,
                expiresDate: type === 'EXTERNAL' ? current.expiresDate : '',
                roleId:
                  type === 'EXTERNAL' && role && !role.allowExternalAssignment
                    ? ''
                    : current.roleId,
              };
            });
            setErrors(({ expiresAt: _expiresAt, ...rest }) => rest);
          }}
        >
          <option value="INTERNAL">{t('form.typeInternal')}</option>
          <option value="EXTERNAL">{t('form.typeExternal')}</option>
        </select>
        {fieldError('type')}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={idOf('jobTitle')} className="text-sm font-medium">
          {t('form.jobTitle')}
        </label>
        <input
          id={idOf('jobTitle')}
          maxLength={150}
          className={INPUT}
          value={form.jobTitle}
          aria-invalid={errors.jobTitle !== undefined}
          aria-describedby={describedBy('jobTitle')}
          onChange={(event) => {
            update('jobTitle', event.target.value);
          }}
        />
        {fieldError('jobTitle')}
      </div>

      {form.type === 'EXTERNAL' ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={idOf('expiresAt')} className="text-sm font-medium">
            {t('form.expiresAt')}
          </label>
          <input
            id={idOf('expiresAt')}
            type="date"
            min={todayLocalDate()}
            className={INPUT}
            value={form.expiresDate}
            aria-invalid={errors.expiresAt !== undefined}
            aria-describedby={describedBy('expiresAt', `${idOf('expiresAt')}-hint`)}
            onChange={(event) => {
              update('expiresDate', event.target.value);
            }}
          />
          <p id={`${idOf('expiresAt')}-hint`} className="text-xs text-muted-foreground">
            {t('form.expiresAtHint')}
          </p>
          {fieldError('expiresAt')}
        </div>
      ) : null}

      <DepartmentMultiSelect
        id={idOf('departmentIds')}
        value={form.departmentIds}
        error={errors.departmentIds}
        onChange={(departmentIds) => {
          update('departmentIds', departmentIds);
        }}
      />

      {assignableRoles.length > 0 ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={idOf('roleId')} className="text-sm font-medium">
            {t('form.role')}
          </label>
          <select
            id={idOf('roleId')}
            className={INPUT}
            value={form.roleId}
            aria-invalid={errors.roleId !== undefined}
            aria-describedby={describedBy('roleId')}
            onChange={(event) => {
              update('roleId', event.target.value);
            }}
          >
            <option value="">{t('form.roleNone')}</option>
            {assignableRoles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
          {fieldError('roleId')}
        </div>
      ) : null}

      <div aria-live="polite">
        {formError ? (
          <Alert tone="error" title={formError}>
            {needsMfa ? (
              <a className="font-medium underline" href={stepUpHref(returnTo)}>
                {t('errors.stepUp')}
              </a>
            ) : null}
          </Alert>
        ) : null}
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            onOpenChange(false);
          }}
        >
          {t('form.cancel')}
        </Button>
        <Button type="submit" disabled={create.isPending} aria-busy={create.isPending}>
          {create.isPending ? t('form.submitting') : t('form.submit')}
        </Button>
      </div>
    </form>
  );
}
