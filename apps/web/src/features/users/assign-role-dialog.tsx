'use client';

import {
  Alert,
  Button,
  Checkbox,
  Combobox,
  DatePicker,
  Field,
  Label,
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

export interface AssignRoleDialogProps {
  readonly open: boolean;
  readonly membership: TenantMembershipDetailDto;
  readonly returnTo: string;
  readonly onClose: () => void;
  readonly onAssigned: (assignment: RoleAssignmentDto) => void;
}

/**
 * Formulário "Atribuir perfil" (SCR-029 · US-096 · ROL-11) em painel lateral (`Sheet` do kit,
 * foco inicial no Perfil): perfil, escopo (órgão ou unidade conforme o tipo, com "Incluir
 * subárvore") e vigência (`DatePicker`). Vínculo externo: só perfis com
 * `allowExternalAssignment` habilitados (FA-03). Erros por campo vêm do mesmo schema da API.
 */
export function AssignRoleDialog(props: AssignRoleDialogProps) {
  const { open, onClose } = props;
  const t = useTranslations('users.detail.roles');
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent closeLabel={t('close')}>{open ? <Body {...props} /> : null}</SheetContent>
    </Sheet>
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
  const idOf = (field: AssignField | 'includeSubtree') => `${formId}-${field}`;
  const subtree = SUBTREE_SCOPE_TYPES.includes(form.scopeType);
  const dateLabels = {
    placeholder: t('datePlaceholder'),
    clear: t('dateClear'),
    calendar: t('dateCalendar'),
  };
  const todayDate = fromIsoDate(todayLocalDate()) ?? new Date();

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <SheetHeader>
        <SheetTitle>{t('assignTitle', { name: membership.name })}</SheetTitle>
        <SheetDescription>{t('assignDescription')}</SheetDescription>
      </SheetHeader>

      <SheetBody>
        <div aria-live="assertive" className="empty:hidden">
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

        <Field
          label={t('role')}
          id={idOf('roleId')}
          description={external ? t('externalHint') : undefined}
          error={errors.roleId}
        >
          <Select
            value={form.roleId}
            onValueChange={(value) => {
              update('roleId', value);
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder={roles.isPending ? t('loadingOptions') : t('selectRole')} />
            </SelectTrigger>
            <SelectContent>
              {sortedRoles.map((role) => {
                const blocked = external && !role.allowExternalAssignment;
                return (
                  <SelectItem
                    key={role.id}
                    value={role.id}
                    disabled={blocked}
                    title={blocked ? t('externalBlocked') : undefined}
                  >
                    {blocked ? `${role.name} — ${t('externalBlockedShort')}` : role.name}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </Field>

        <Field label={t('scope')} id={idOf('scopeType')} error={errors.scopeType}>
          <Select
            value={form.scopeType}
            onValueChange={(value) => {
              const scopeType = value as ScopeTypeValue;
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
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCOPE_TYPES.map((scope) => (
                <SelectItem key={scope} value={scope}>
                  {t(`scopes.${scope}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {form.scopeType === 'ORGANIZATION' ? (
          <Field
            label={t('organization')}
            id={idOf('scopeOrganizationId')}
            error={errors.scopeOrganizationId}
          >
            <Select
              value={form.scopeOrganizationId}
              onValueChange={(value) => {
                update('scopeOrganizationId', value);
              }}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    organizations.isPending ? t('loadingOptions') : t('selectOrganization')
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {(organizations.data ?? [])
                  .filter((organization) => organization.isActive)
                  .map((organization) => (
                    <SelectItem key={organization.id} value={organization.id}>
                      {organization.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}

        {form.scopeType === 'DEPARTMENT' ? (
          <Field
            label={t('department')}
            id={idOf('scopeDepartmentId')}
            error={errors.scopeDepartmentId}
          >
            <Combobox
              options={(departments.data ?? []).map((department) => ({
                value: department.id,
                label: department.path,
              }))}
              value={form.scopeDepartmentId}
              labels={{
                placeholder: departments.isPending ? t('loadingOptions') : t('selectDepartment'),
                search: t('searchDepartment'),
                empty: t('noDepartment'),
              }}
              onValueChange={(value) => {
                update('scopeDepartmentId', value ?? '');
              }}
            />
          </Field>
        ) : null}

        {subtree ? (
          <div className="flex items-center gap-2.5">
            <Checkbox
              id={idOf('includeSubtree')}
              checked={form.includeSubtree}
              onCheckedChange={(checked) => {
                update('includeSubtree', checked === true);
              }}
            />
            <Label htmlFor={idOf('includeSubtree')}>{t('includeSubtree')}</Label>
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t('validFrom')}
            id={idOf('validFrom')}
            description={t('validFromHint')}
            error={errors.validFrom}
          >
            <DatePicker
              value={fromIsoDate(form.validFromDate)}
              disabledDays={{ before: todayDate }}
              labels={dateLabels}
              clearable
              onValueChange={(date) => {
                update('validFromDate', date ? toIsoDate(date) : '');
              }}
            />
          </Field>
          <Field
            label={t('validUntil')}
            id={idOf('validUntil')}
            description={external ? t('validUntilExternalHint') : t('validUntilHint')}
            error={errors.validUntil}
          >
            <DatePicker
              value={fromIsoDate(form.validUntilDate)}
              disabledDays={{ before: fromIsoDate(form.validFromDate) ?? todayDate }}
              labels={dateLabels}
              clearable
              onValueChange={(date) => {
                update('validUntilDate', date ? toIsoDate(date) : '');
              }}
            />
          </Field>
        </div>
      </SheetBody>

      <SheetFooter>
        <Button type="button" variant="secondary" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={assign.isPending} aria-busy={assign.isPending}>
          {assign.isPending ? t('assigning') : t('confirmAssign')}
        </Button>
      </SheetFooter>
    </form>
  );
}
