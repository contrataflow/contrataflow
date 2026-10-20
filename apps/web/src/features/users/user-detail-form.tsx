'use client';

import { Button } from '@contrataflow/ui';
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

const INPUT = 'h-10 rounded-control border border-border bg-surface px-3 text-sm';

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
  const errorIdOf = (field: ProfileField) => `${ids}-${field}-error`;

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
  const describedBy = (field: ProfileField, extra?: string) =>
    [extra, errors[field] ? errorIdOf(field) : undefined].filter(Boolean).join(' ') || undefined;
  const fieldError = (field: ProfileField) =>
    errors[field] ? (
      <p id={errorIdOf(field)} className="text-sm text-destructive">
        {errors[field]}
      </p>
    ) : null;

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
        <div className="flex flex-col gap-1">
          <label htmlFor={idOf('jobTitle')} className="text-sm font-medium">
            {t('detail.jobTitle')}
          </label>
          <input
            id={idOf('jobTitle')}
            autoComplete="off"
            // eslint-disable-next-line jsx-a11y/no-autofocus -- foco no primeiro campo ao abrir o formulário
            autoFocus
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

        <div className="flex flex-col gap-1">
          <label htmlFor={idOf('registrationNumber')} className="text-sm font-medium">
            {t('detail.registrationNumber')}
          </label>
          <input
            id={idOf('registrationNumber')}
            autoComplete="off"
            className={INPUT}
            value={form.registrationNumber}
            aria-invalid={errors.registrationNumber !== undefined}
            aria-describedby={describedBy('registrationNumber')}
            onChange={(event) => {
              update('registrationNumber', event.target.value);
            }}
          />
          {fieldError('registrationNumber')}
        </div>

        {external ? (
          <div className="flex flex-col gap-1">
            <label htmlFor={idOf('expiresAt')} className="text-sm font-medium">
              {t('detail.expiresAt')}
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
              {t('detail.expiresAtHint')}
            </p>
            {fieldError('expiresAt')}
          </div>
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
