'use client';

import { Button, DatePicker, Field, Input, fromIsoDate, toIsoDate } from '@contrataflow/ui';
import type { TenantMembershipDetailDto } from '@contrataflow/validation';
import { useMutation } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useId, useState } from 'react';
import type { SyntheticEvent } from 'react';

import { isApiError } from '@/lib/api/api-error';

import { todayLocalDate } from './invite-form-model';
import {
  firstProfileErrorField,
  hasProfileChanges,
  profileFieldOf,
  profileStateOf,
  validateProfile,
} from './user-detail-model';
import type { ProfileErrors, ProfileField, ProfileFormState } from './user-detail-model';
import { updateUser } from './users.api';
import type { UserDetailResult } from './users.api';

export interface UserDetailFormProps {
  readonly membership: TenantMembershipDetailDto;
  /** `UPDATE` em `allowedActions` (exige `USER_MANAGE`); sem ele os dados são só leitura. */
  readonly canEdit: boolean;
  /** O detalhe está sendo recarregado: bloqueia o envio até chegar a versão atual. */
  readonly locked: boolean;
  readonly onSaved: (result: UserDetailResult) => void;
  /** Erro que a tela trata (412, 409, 404, 503…); `retry` repete o envio. */
  readonly onFailed: (error: unknown, retry: () => void) => void;
}

/**
 * `UserDetailForm` (SCR-029 · US-092 · USR-08): cargo, matrícula e, só para vínculo `EXTERNAL`, a
 * validade. "Salvar" envia só o que mudou, com o `If-Match` da versão lida. Limites validados com o
 * schema da API (V-01); erros 422 vão para o campo e o foco para o primeiro inválido.
 */
export function UserDetailForm({
  membership,
  canEdit,
  locked,
  onSaved,
  onFailed,
}: UserDetailFormProps) {
  const t = useTranslations('users');
  const format = useFormatter();
  const ids = useId();
  const [form, setForm] = useState<ProfileFormState>(() => profileStateOf(membership));
  const [errors, setErrors] = useState<ProfileErrors>({});
  const [focusRequest, setFocusRequest] = useState<{ field: ProfileField; n: number } | null>(null);
  const external = membership.type === 'EXTERNAL';

  const idOf = (field: ProfileField) => `${ids}-${field}`;

  useEffect(() => {
    if (!focusRequest) return;
    document.getElementById(`${ids}-${focusRequest.field}`)?.focus();
  }, [focusRequest, ids]);

  const fail = (next: ProfileErrors) => {
    setErrors(next);
    const field = firstProfileErrorField(next);
    if (field) setFocusRequest((current) => ({ field, n: (current?.n ?? 0) + 1 }));
  };

  const save = useMutation({
    mutationFn: (patch: Parameters<typeof updateUser>[1]) =>
      updateUser(membership.userId, patch, membership.version),
    onSuccess: (result) => {
      setErrors({});
      onSaved(result);
    },
  });

  const submit = (data: Parameters<typeof updateUser>[1]) => {
    save.mutate(data, {
      onError: (error) => {
        if (isApiError(error) && error.status === 422) {
          const fieldErrors: ProfileErrors = {};
          for (const item of error.errors) {
            const field = profileFieldOf(item.field);
            if (field) fieldErrors[field] ??= item.message;
          }
          if (Object.keys(fieldErrors).length > 0) {
            fail(fieldErrors);
            return;
          }
        }
        onFailed(error, () => {
          submit(data);
        });
      },
    });
  };

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validation = validateProfile(membership, form);
    if (!validation.ok) {
      fail(validation.errors);
      return;
    }
    setErrors({});
    submit(validation.data);
  };

  const update = (key: keyof ProfileFormState, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const dirty = hasProfileChanges(membership, form);
  const expiresLabel = membership.expiresAt
    ? format.dateTime(new Date(membership.expiresAt), { dateStyle: 'short' })
    : t('detail.none');

  if (!canEdit) {
    return (
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="font-medium">{t('detail.jobTitle')}</dt>
          <dd className="text-muted-foreground">{membership.jobTitle ?? t('detail.none')}</dd>
        </div>
        <div>
          <dt className="font-medium">{t('detail.registrationNumber')}</dt>
          <dd className="text-muted-foreground">
            {membership.registrationNumber ?? t('detail.none')}
          </dd>
        </div>
        {external ? (
          <div>
            <dt className="font-medium">{t('detail.expiresAt')}</dt>
            <dd className="text-muted-foreground">{expiresLabel}</dd>
          </div>
        ) : null}
      </dl>
    );
  }

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('detail.jobTitle')} id={idOf('jobTitle')} error={errors.jobTitle}>
          <Input
            autoComplete="off"
            // eslint-disable-next-line jsx-a11y/no-autofocus -- foco no primeiro campo ao abrir o formulário
            autoFocus
            value={form.jobTitle}
            onChange={(event) => {
              update('jobTitle', event.target.value);
            }}
          />
        </Field>

        <Field
          label={t('detail.registrationNumber')}
          id={idOf('registrationNumber')}
          error={errors.registrationNumber}
        >
          <Input
            autoComplete="off"
            value={form.registrationNumber}
            onChange={(event) => {
              update('registrationNumber', event.target.value);
            }}
          />
        </Field>

        {external ? (
          <Field
            label={t('detail.expiresAt')}
            id={idOf('expiresAt')}
            description={t('detail.expiresAtHint')}
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
      </div>

      <div className="flex justify-end">
        <Button
          type="submit"
          disabled={!dirty || save.isPending || locked}
          aria-busy={save.isPending}
        >
          {save.isPending ? t('detail.saving') : t('detail.save')}
        </Button>
      </div>
    </form>
  );
}
