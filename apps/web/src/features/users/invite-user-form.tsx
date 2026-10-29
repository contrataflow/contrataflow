'use client';

import {
  Alert,
  Button,
  DatePicker,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  fromIsoDate,
  toIsoDate,
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

/** O `Select` do kit não aceita valor vazio: "sem perfil inicial" usa este marcador. */
const NO_ROLE = 'none';

export interface InviteUserFormProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Rota de retorno do *step-up* de MFA. */
  readonly returnTo: string;
}

/**
 * `InviteUserForm` (SCR-029 · US-091 · USR-03) em painel lateral (`Sheet` do kit): e-mail, nome,
 * tipo de vínculo, cargo, validade (só `EXTERNAL`), lotação e perfil inicial, validados com o
 * `inviteUserSchema` da API. Erros 422 vão para os campos e o foco para o primeiro; 409 sugere
 * reenviar o convite existente; 503 e demais falhas mantêm o que foi digitado.
 */
export function InviteUserForm(props: InviteUserFormProps) {
  const t = useTranslations('users');
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent closeLabel={t('form.close')}>
        {props.open ? <InviteUserBody {...props} /> : null}
      </SheetContent>
    </Sheet>
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

  const onTypeChange = (value: string) => {
    const type = value === 'EXTERNAL' ? 'EXTERNAL' : 'INTERNAL';
    setForm((current) => {
      const role = roles.data?.find((item) => item.id === current.roleId);
      return {
        ...current,
        type,
        expiresDate: type === 'EXTERNAL' ? current.expiresDate : '',
        roleId: type === 'EXTERNAL' && role && !role.allowExternalAssignment ? '' : current.roleId,
      };
    });
    setErrors(({ expiresAt: _expiresAt, ...rest }) => rest);
  };

  return (
    <form
      noValidate
      onSubmit={(event) => {
        void onSubmit(event);
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <SheetHeader>
        <SheetTitle>{t('form.title')}</SheetTitle>
        <SheetDescription>{t('form.description')}</SheetDescription>
      </SheetHeader>

      <SheetBody>
        <div aria-live="polite" className="empty:hidden">
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

        <Field label={t('form.email')} id={idOf('email')} error={errors.email}>
          <Input
            type="email"
            autoComplete="off"
            value={form.email}
            onChange={(event) => {
              update('email', event.target.value);
            }}
          />
          {alreadyMember ? (
            <p className="text-sm text-muted-foreground">{t('form.alreadyMemberHint')}</p>
          ) : null}
        </Field>

        <Field label={t('form.name')} id={idOf('name')} error={errors.name}>
          <Input
            autoComplete="off"
            maxLength={200}
            value={form.name}
            onChange={(event) => {
              update('name', event.target.value);
            }}
          />
        </Field>

        <Field label={t('form.type')} id={idOf('type')} error={errors.type}>
          <Select value={form.type} onValueChange={onTypeChange}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="INTERNAL">{t('form.typeInternal')}</SelectItem>
              <SelectItem value="EXTERNAL">{t('form.typeExternal')}</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <Field label={t('form.jobTitle')} id={idOf('jobTitle')} error={errors.jobTitle}>
          <Input
            autoComplete="off"
            maxLength={150}
            value={form.jobTitle}
            onChange={(event) => {
              update('jobTitle', event.target.value);
            }}
          />
        </Field>

        {form.type === 'EXTERNAL' ? (
          <Field
            label={t('form.expiresAt')}
            id={idOf('expiresAt')}
            description={t('form.expiresAtHint')}
            error={errors.expiresAt}
          >
            <DatePicker
              value={fromIsoDate(form.expiresDate)}
              disabledDays={{ before: fromIsoDate(todayLocalDate()) ?? new Date() }}
              labels={{
                placeholder: t('form.datePlaceholder'),
                clear: t('form.dateClear'),
                calendar: t('form.dateCalendar'),
              }}
              onValueChange={(date) => {
                update('expiresDate', date ? toIsoDate(date) : '');
              }}
            />
          </Field>
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
          <Field label={t('form.role')} id={idOf('roleId')} error={errors.roleId}>
            <Select
              value={form.roleId === '' ? NO_ROLE : form.roleId}
              onValueChange={(value) => {
                update('roleId', value === NO_ROLE ? '' : value);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_ROLE}>{t('form.roleNone')}</SelectItem>
                {assignableRoles.map((role) => (
                  <SelectItem key={role.id} value={role.id}>
                    {role.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}
      </SheetBody>

      <SheetFooter>
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
      </SheetFooter>
    </form>
  );
}
