'use client';

import { Button } from '@contrataflow/ui';
import type { TenantMembershipDetailDto } from '@contrataflow/validation';
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useMemo, useState } from 'react';
import type { SyntheticEvent } from 'react';

import { isApiError } from '@/lib/api/api-error';

import { DepartmentTreeMultiSelect } from './department-tree-multi-select';
import {
  departmentFieldOf,
  departmentsStateOf,
  hasDepartmentChanges,
  validateDepartments,
} from './user-detail-model';
import type { DepartmentErrors, DepartmentsState } from './user-detail-model';
import { updateUserDepartments } from './users.api';
import type { UserDetailResult } from './users.api';

export interface UserDepartmentsFormProps {
  readonly membership: TenantMembershipDetailDto;
  /** `UPDATE_DEPARTMENTS` em `allowedActions`; sem ele as lotações são só leitura. */
  readonly canEdit: boolean;
  readonly locked: boolean;
  readonly onSaved: (result: UserDetailResult) => void;
  readonly onFailed: (error: unknown, retry: () => void) => void;
}

/**
 * Lotações do vínculo (SCR-029 · US-092 · USR-09): seleção em bloco com a principal explícita.
 * Lista vazia é bloqueada antes de enviar (FA-04 · V-04); "Salvar lotações" envia o conjunto
 * completo com o `If-Match` da versão lida.
 */
export function UserDepartmentsForm({
  membership,
  canEdit,
  locked,
  onSaved,
  onFailed,
}: UserDepartmentsFormProps) {
  const t = useTranslations('users');
  const id = useId();
  const [state, setState] = useState<DepartmentsState>(() => departmentsStateOf(membership));
  const [errors, setErrors] = useState<DepartmentErrors>({});
  const names = useMemo(
    () => new Map(membership.departments.map((department) => [department.id, department.name])),
    [membership.departments],
  );

  const save = useMutation({
    mutationFn: (body: Parameters<typeof updateUserDepartments>[1]) =>
      updateUserDepartments(membership.userId, body, membership.version),
    onSuccess: (result) => {
      setErrors({});
      onSaved(result);
    },
  });

  const submit = (data: Parameters<typeof updateUserDepartments>[1]) => {
    save.mutate(data, {
      onError: (error) => {
        if (isApiError(error) && error.status === 422) {
          const fieldErrors: DepartmentErrors = {};
          for (const item of error.errors) {
            const field = departmentFieldOf(item.field);
            if (field)
              fieldErrors[field === 'primaryDepartmentId' ? 'departmentIds' : field] ??=
                item.message;
          }
          if (Object.keys(fieldErrors).length > 0) {
            setErrors(fieldErrors);
            document.getElementById(`${id}-departments`)?.focus();
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
    const validation = validateDepartments(state);
    if (!validation.ok) {
      const { primaryDepartmentId, ...rest } = validation.errors;
      setErrors({
        ...rest,
        ...(primaryDepartmentId ? { departmentIds: primaryDepartmentId } : {}),
      });
      document.getElementById(`${id}-departments`)?.focus();
      return;
    }
    setErrors({});
    submit(validation.data);
  };

  if (!canEdit) {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="sr-only">{t('detail.departmentsReadonly')}</h3>
        {membership.departments.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('detail.noDepartments')}</p>
        ) : (
          <ul aria-label={t('detail.departmentsReadonly')} className="flex flex-wrap gap-2">
            {membership.departments.map((department) => (
              <li
                key={department.id}
                className="inline-flex items-center gap-1 rounded-control bg-muted px-2 py-1 text-sm"
              >
                <span>{department.name}</span>
                {department.isPrimary ? (
                  <strong className="text-xs">({t('detail.primaryBadge')})</strong>
                ) : null}
                {department.isActive ? null : (
                  <span className="text-xs text-muted-foreground">
                    ({t('detail.inactiveBadge')})
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
      <DepartmentTreeMultiSelect
        id={`${id}-departments`}
        value={state.ids}
        primary={state.primary}
        names={names}
        error={errors.departmentIds}
        onChange={(ids, primary) => {
          setState({ ids, primary });
          setErrors({});
        }}
      />
      <div className="flex justify-end">
        <Button
          type="submit"
          disabled={!hasDepartmentChanges(membership, state) || save.isPending || locked}
          aria-busy={save.isPending}
        >
          {save.isPending ? t('detail.saving') : t('detail.departmentsSave')}
        </Button>
      </div>
    </form>
  );
}
