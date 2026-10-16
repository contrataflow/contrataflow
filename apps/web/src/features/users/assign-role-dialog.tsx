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
import { SCOPE_TYPES, SUBTREE_SCOPE_TYPES } from '@contrataflow/validation';
import type {
  AssignRole,
  RoleAssignmentDto,
  ScopeTypeValue,
  TenantMembershipDetailDto,
} from '@contrataflow/validation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useMemo, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { newIdempotencyKey } from '@/lib/api/client';
import { stepUpHref } from '@/lib/api/error-policy';
import { useTenantId } from '@/lib/session/session-context';

import { todayLocalDate } from './invite-form-model';
import { EMPTY_ASSIGN_FORM, apiFieldErrors, validateAssign } from './role-assignment-model';
import type { AssignErrors, AssignField, AssignFormState } from './role-assignment-model';
import { assignRole, fetchActiveOrganizations, roleAssignmentKeys } from './role-assignments.api';
import { LOOKUP_STALE_TIME_MS, fetchActiveRoles, lookupDepartments, userKeys } from './users.api';

const INPUT = 'h-10 rounded-control border border-border bg-surface px-3 text-sm';

export interface AssignRoleDialogProps {
  readonly open: boolean;
  readonly membership: TenantMembershipDetailDto;
  readonly returnTo: string;
  readonly onClose: () => void;
  readonly onAssigned: (assignment: RoleAssignmentDto) => void;
}

/**
 * Formulário "Atribuir perfil" (SCR-029 · US-096 · ROL-11) em modal acessível por teclado (foco
 * inicial no Perfil): `RoleSelect`, `ScopeFieldset` (órgão ou unidade conforme o escopo, com
 * "Incluir subárvore") e `DateRangeFields`. Vínculo externo: só perfis com
 * `allowExternalAssignment` habilitados (FA-03). Erros por campo vêm do mesmo schema da API.
 */
export function AssignRoleDialog(props: AssignRoleDialogProps) {
  const { open, onClose } = props;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>{open ? <Body {...props} /> : null}</DialogContent>
    </Dialog>
  );
}

function Body({ membership, returnTo, onClose, onAssigned }: AssignRoleDialogProps) {
  const t = useTranslations('users.detail.roles');
  const tenantId = useTenantId();
  const formId = useId();
  const [form, setForm] = useState<AssignFormState>(EMPTY_ASSIGN_FORM);
  const [errors, setErrors] = useState<AssignErrors>({});
  const [failure, setFailure] = useState<{ message: string; mfa: boolean } | null>(null);
  // A mesma chave para as repetições da mesma intenção (503, duplo clique).
  const [idempotencyKey] = useState(newIdempotencyKey);
  const external = membership.type === 'EXTERNAL';

  const roles = useQuery({
    queryKey: userKeys.activeRoles(tenantId),
    queryFn: async ({ signal }) => (await fetchActiveRoles(signal)).data,
    staleTime: LOOKUP_STALE_TIME_MS,
  });
  const organizations = useQuery({
    queryKey: roleAssignmentKeys.activeOrganizations(tenantId),
    queryFn: async ({ signal }) => (await fetchActiveOrganizations(signal)).data,
    staleTime: LOOKUP_STALE_TIME_MS,
    enabled: form.scopeType === 'ORGANIZATION',
  });
  const departments = useQuery({
    queryKey: userKeys.departmentLookup(tenantId, ''),
    queryFn: async ({ signal }) => (await lookupDepartments('', signal)).data,
    staleTime: LOOKUP_STALE_TIME_MS,
    enabled: form.scopeType === 'DEPARTMENT',
  });

  const assign = useMutation({
    mutationFn: (body: AssignRole) => assignRole(membership.userId, body, idempotencyKey),
    onSuccess: (result) => {
      onAssigned(result.data);
    },
    onError: (error) => {
      const fields = apiFieldErrors(error);
      if (Object.keys(fields).length > 0) {
        setErrors(fields);
        return;
      }
      setFailure({
        message: isApiError(error) && error.message ? error.message : t('errors.generic'),
        mfa: isApiError(error) && error.code === 'MFA_REQUIRED',
      });
    },
  });

  const update = <K extends keyof AssignFormState>(key: K, value: AssignFormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors({});
    setFailure(null);
  };

  const submit = () => {
    const result = validateAssign(form, membership);
    if (result.errors) {
      setErrors(result.errors);
      const first = (Object.keys(result.errors) as AssignField[])[0];
      if (first) document.getElementById(`${formId}-${first}`)?.focus();
      return;
    }
    setFailure(null);
    assign.mutate(result.body);
  };

  const sortedRoles = useMemo(
    () => [...(roles.data ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')),
    [roles.data],
  );
  const idOf = (field: AssignField) => `${formId}-${field}`;
  const describedBy = (field: AssignField, hint?: boolean) =>
    [hint ? `${idOf(field)}-hint` : null, errors[field] ? `${idOf(field)}-error` : null]
      .filter(Boolean)
      .join(' ') || undefined;
  const fieldError = (field: AssignField) =>
    errors[field] ? (
      <p id={`${idOf(field)}-error`} className="text-sm text-destructive">
        {errors[field]}
      </p>
    ) : null;
  const subtree = SUBTREE_SCOPE_TYPES.includes(form.scopeType);

  return (
    <>
      <DialogTitle>{t('assignTitle', { name: membership.name })}</DialogTitle>
      <DialogDescription>{t('assignDescription')}</DialogDescription>

      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {/* RoleSelect */}
        <div className="flex flex-col gap-1">
          <label htmlFor={idOf('roleId')} className="text-sm font-medium">
            {t('role')}
          </label>
          <select
            id={idOf('roleId')}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- foco inicial no Perfil (story)
            autoFocus
            className={INPUT}
            value={form.roleId}
            aria-invalid={errors.roleId !== undefined}
            aria-describedby={describedBy('roleId', external)}
            onChange={(event) => {
              update('roleId', event.target.value);
            }}
          >
            <option value="">{roles.isPending ? t('loadingOptions') : t('selectRole')}</option>
            {sortedRoles.map((role) => {
              const blocked = external && !role.allowExternalAssignment;
              return (
                <option
                  key={role.id}
                  value={role.id}
                  disabled={blocked}
                  title={blocked ? t('externalBlocked') : undefined}
                >
                  {blocked ? `${role.name} — ${t('externalBlockedShort')}` : role.name}
                </option>
              );
            })}
          </select>
          {external ? (
            <p id={`${idOf('roleId')}-hint`} className="text-xs text-muted-foreground">
              {t('externalHint')}
            </p>
          ) : null}
          {fieldError('roleId')}
        </div>

        {/* ScopeFieldset */}
        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-medium">{t('scope')}</legend>
          <select
            id={idOf('scopeType')}
            aria-label={t('scope')}
            className={INPUT}
            value={form.scopeType}
            aria-invalid={errors.scopeType !== undefined}
            aria-describedby={describedBy('scopeType')}
            onChange={(event) => {
              const scopeType = event.target.value as ScopeTypeValue;
              setForm((current) => ({
                ...current,
                scopeType,
                scopeOrganizationId: '',
                scopeDepartmentId: '',
                includeSubtree: true,
              }));
              setErrors({});
            }}
          >
            {SCOPE_TYPES.map((scope) => (
              <option key={scope} value={scope}>
                {t(`scopes.${scope}`)}
              </option>
            ))}
          </select>
          {fieldError('scopeType')}

          {form.scopeType === 'ORGANIZATION' ? (
            <div className="flex flex-col gap-1">
              <label htmlFor={idOf('scopeOrganizationId')} className="text-sm font-medium">
                {t('organization')}
              </label>
              <select
                id={idOf('scopeOrganizationId')}
                className={INPUT}
                value={form.scopeOrganizationId}
                aria-invalid={errors.scopeOrganizationId !== undefined}
                aria-describedby={describedBy('scopeOrganizationId')}
                onChange={(event) => {
                  update('scopeOrganizationId', event.target.value);
                }}
              >
                <option value="">
                  {organizations.isPending ? t('loadingOptions') : t('selectOrganization')}
                </option>
                {(organizations.data ?? [])
                  .filter((organization) => organization.isActive)
                  .map((organization) => (
                    <option key={organization.id} value={organization.id}>
                      {organization.name}
                    </option>
                  ))}
              </select>
              {fieldError('scopeOrganizationId')}
            </div>
          ) : null}

          {form.scopeType === 'DEPARTMENT' ? (
            <div className="flex flex-col gap-1">
              <label htmlFor={idOf('scopeDepartmentId')} className="text-sm font-medium">
                {t('department')}
              </label>
              <select
                id={idOf('scopeDepartmentId')}
                className={INPUT}
                value={form.scopeDepartmentId}
                aria-invalid={errors.scopeDepartmentId !== undefined}
                aria-describedby={describedBy('scopeDepartmentId')}
                onChange={(event) => {
                  update('scopeDepartmentId', event.target.value);
                }}
              >
                <option value="">
                  {departments.isPending ? t('loadingOptions') : t('selectDepartment')}
                </option>
                {(departments.data ?? []).map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.path}
                  </option>
                ))}
              </select>
              {fieldError('scopeDepartmentId')}
            </div>
          ) : null}

          {subtree ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.includeSubtree}
                onChange={(event) => {
                  update('includeSubtree', event.target.checked);
                }}
              />
              {t('includeSubtree')}
            </label>
          ) : null}
        </fieldset>

        {/* DateRangeFields */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label htmlFor={idOf('validFrom')} className="text-sm font-medium">
              {t('validFrom')}
            </label>
            <input
              id={idOf('validFrom')}
              type="date"
              className={INPUT}
              min={todayLocalDate()}
              value={form.validFromDate}
              aria-invalid={errors.validFrom !== undefined}
              aria-describedby={describedBy('validFrom', true)}
              onChange={(event) => {
                update('validFromDate', event.target.value);
              }}
            />
            <p id={`${idOf('validFrom')}-hint`} className="text-xs text-muted-foreground">
              {t('validFromHint')}
            </p>
            {fieldError('validFrom')}
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={idOf('validUntil')} className="text-sm font-medium">
              {t('validUntil')}
            </label>
            <input
              id={idOf('validUntil')}
              type="date"
              className={INPUT}
              min={form.validFromDate || todayLocalDate()}
              value={form.validUntilDate}
              aria-invalid={errors.validUntil !== undefined}
              aria-describedby={describedBy('validUntil', true)}
              onChange={(event) => {
                update('validUntilDate', event.target.value);
              }}
            />
            <p id={`${idOf('validUntil')}-hint`} className="text-xs text-muted-foreground">
              {external ? t('validUntilExternalHint') : t('validUntilHint')}
            </p>
            {fieldError('validUntil')}
          </div>
        </div>

        <div aria-live="assertive">
          {failure ? (
            <Alert tone="error" title={failure.message}>
              {failure.mfa ? (
                <a className="font-medium underline" href={stepUpHref(returnTo)}>
                  {t('errors.stepUp')}
                </a>
              ) : null}
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" disabled={assign.isPending} aria-busy={assign.isPending}>
            {assign.isPending ? t('assigning') : t('confirmAssign')}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
