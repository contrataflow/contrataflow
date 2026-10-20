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
import { DEPARTMENT_TYPES } from '@contrataflow/validation';
import type { DepartmentDto } from '@contrataflow/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';

import { isApiError } from '@/lib/api/api-error';
import { newIdempotencyKey } from '@/lib/api/client';
import { useTenantId } from '@/lib/session/session-context';

import {
  DEPARTMENT_FORM_FIELDS,
  buildCreateBody,
  buildPatch,
  initialValues,
  validateCreate,
  validatePatch,
} from './department-form-model';
import type { DepartmentFormField, DepartmentFormValues } from './department-form-model';
import { typeLabel } from './department-tree-model';
import type { StructureLabels } from './department-tree-model';
import {
  createDepartment,
  departmentKeys,
  fetchDepartment,
  updateDepartment,
} from './departments.api';
import { UserLookupSelect } from './user-lookup-select';

const INPUT = 'h-10 rounded-control border border-border bg-surface px-3 text-sm';
const FORM_FIELDS = new Set<string>(DEPARTMENT_FORM_FIELDS);

export type DepartmentFormTarget =
  | { readonly mode: 'create'; readonly parent: DepartmentDto | null }
  | { readonly mode: 'edit'; readonly department: DepartmentDto };

export interface DepartmentFormDialogProps {
  readonly target: DepartmentFormTarget | null;
  readonly organizationId: string;
  readonly labels: StructureLabels;
  readonly onClose: () => void;
}

/**
 * `DepartmentFormDialog` (SCR-032 · US-102 · passos 2–6): React Hook Form validado pelos mesmos
 * schemas Zod da API. Criação (DEP-03, com `Idempotency-Key` por intenção) na raiz ou sob a
 * unidade escolhida; edição (DEP-05) só do que mudou, com `If-Match` — 412 oferece "Recarregar e
 * reaplicar minhas alterações". Foco no primeiro campo; erros em `aria-live`; tela cheia abaixo de
 * 768 px.
 */
export function DepartmentFormDialog({
  target,
  organizationId,
  labels,
  onClose,
}: DepartmentFormDialogProps) {
  const key =
    target === null
      ? 'fechado'
      : target.mode === 'edit'
        ? target.department.id
        : `novo-${target.parent?.id ?? 'raiz'}`;
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="h-dvh max-h-dvh overflow-y-auto md:h-auto md:max-h-[90vh]"
        style={{ maxWidth: '40rem' }}
      >
        {target ? (
          <DepartmentFormBody
            key={key}
            target={target}
            organizationId={organizationId}
            labels={labels}
            onClose={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DepartmentFormBody({
  target,
  organizationId,
  labels,
  onClose,
}: {
  readonly target: DepartmentFormTarget;
  readonly organizationId: string;
  readonly labels: StructureLabels;
  readonly onClose: () => void;
}) {
  const t = useTranslations('departments');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const ids = useId();
  const [base, setBase] = useState(target.mode === 'edit' ? target.department : undefined);
  const [conflict, setConflict] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // Uma chave por intenção de criar: o reenvio após falha transitória não duplica a unidade.
  const idempotencyKey = useRef(newIdempotencyKey());
  const parent = target.mode === 'create' ? target.parent : null;

  const {
    register,
    handleSubmit,
    setError,
    setValue,
    getValues,
    control,
    reset,
    formState: { errors, dirtyFields },
  } = useForm<DepartmentFormValues>({ defaultValues: initialValues(base) });

  const staff = {
    headUserId: useWatch({ control, name: 'headUserId' }),
    deputyUserId: useWatch({ control, name: 'deputyUserId' }),
  };

  const create = useMutation({
    mutationFn: (body: ReturnType<typeof buildCreateBody>) =>
      createDepartment(body, idempotencyKey.current),
  });
  const update = useMutation({
    mutationFn: (input: { id: string; patch: ReturnType<typeof buildPatch>; version: number }) =>
      updateDepartment(input.id, input.patch, input.version),
  });

  const requiredMessage = (field: 'type' | 'name') =>
    t('validation.required', {
      field: t(`form.${field}`)
        .replace(/\s*\*$/, '')
        .toLowerCase(),
    });

  const applyServerErrors = (error: unknown): void => {
    if (!isApiError(error)) {
      setFormError(t('errors.generic'));
      return;
    }
    if (error.status === 412) {
      setConflict(true);
      return;
    }
    if (error.status === 403) {
      setFormError(t('errors.permission'));
      return;
    }
    if (error.status === 404) {
      setFormError(t('errors.notFound'));
      return;
    }
    if (error.status === 503) {
      setFormError(t('errors.unavailable'));
      return;
    }
    let mapped = false;
    for (const fieldError of error.errors) {
      if (FORM_FIELDS.has(fieldError.field)) {
        setError(fieldError.field as DepartmentFormField, { message: fieldError.message });
        mapped = true;
      }
    }
    // `parentId`/`organizationId` recusados: a árvore mudou — recarrega as opções.
    if (!mapped) setFormError(error.errors[0]?.message ?? (error.message || t('errors.generic')));
    void queryClient.invalidateQueries({ queryKey: departmentKeys.all(tenantId) });
  };

  const finish = (saved: DepartmentDto, key: 'created' | 'updated'): void => {
    toast({ title: t(`toast.${key}`, { name: saved.name }), tone: 'success' });
    void queryClient.invalidateQueries({ queryKey: departmentKeys.all(tenantId) });
    onClose();
  };

  const showProblems = (problems: Partial<Record<DepartmentFormField, string>>): boolean => {
    const fields = Object.keys(problems) as DepartmentFormField[];
    for (const field of fields) setError(field, { message: problems[field] ?? '' });
    return fields.length > 0;
  };

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    if (!base) {
      const body = buildCreateBody(values, organizationId, parent?.id ?? null);
      if (showProblems(validateCreate(body, requiredMessage))) return;
      try {
        finish((await create.mutateAsync(body)).data, 'created');
      } catch (error) {
        applyServerErrors(error);
      }
      return;
    }
    const patch = buildPatch(values, base);
    if (showProblems(validatePatch(patch, values, requiredMessage))) return;
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    try {
      finish(
        (await update.mutateAsync({ id: base.id, patch, version: base.version })).data,
        'updated',
      );
    } catch (error) {
      applyServerErrors(error);
    }
  });

  /** 412: relê a unidade (DEP-04) e reaplica só os campos que a pessoa alterou. */
  const reapply = async (): Promise<void> => {
    if (!base) return;
    const mine = getValues();
    const touched = DEPARTMENT_FORM_FIELDS.filter((field) => dirtyFields[field]);
    try {
      const fresh = (await fetchDepartment(base.id)).data;
      setBase(fresh);
      reset(initialValues(fresh));
      for (const field of touched) setValue(field, mine[field], { shouldDirty: true });
      void queryClient.invalidateQueries({ queryKey: departmentKeys.all(tenantId) });
      setConflict(false);
    } catch {
      setConflict(false);
      setFormError(t('errors.notFound'));
    }
  };

  const pending = create.isPending || update.isPending;
  const fieldId = (name: string) => `${ids}-${name}`;
  const errorOf = (name: DepartmentFormField) => errors[name]?.message;
  const describe = (name: DepartmentFormField, hint?: boolean) => {
    const parts = [
      errorOf(name) ? `${fieldId(name)}-error` : undefined,
      hint ? `${fieldId(name)}-hint` : undefined,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : undefined;
  };
  const errorText = (name: DepartmentFormField) =>
    errorOf(name) ? (
      <p id={`${fieldId(name)}-error`} className="text-sm text-destructive" aria-live="polite">
        {errorOf(name)}
      </p>
    ) : null;
  const text = (
    name: Exclude<DepartmentFormField, 'type' | 'headUserId' | 'deputyUserId'>,
    options: { readonly hint?: string; readonly className?: string; readonly type?: string } = {},
  ) => (
    <div className={`flex flex-col gap-1 ${options.className ?? ''}`}>
      <label htmlFor={fieldId(name)} className="text-sm font-medium">
        {t(`form.${name}`)}
      </label>
      <input
        id={fieldId(name)}
        type={options.type ?? 'text'}
        aria-invalid={errorOf(name) ? true : undefined}
        aria-describedby={describe(name, Boolean(options.hint))}
        className={INPUT}
        {...register(name)}
      />
      {options.hint ? (
        <p id={`${fieldId(name)}-hint`} className="text-xs text-muted-foreground">
          {options.hint}
        </p>
      ) : null}
      {errorText(name)}
    </div>
  );

  const parentName = base ? null : (parent?.name ?? t('form.root'));
  const title = base
    ? t('form.editTitle', { name: base.name })
    : parent
      ? t('form.createChildTitle', { parent: parent.name })
      : t('form.createTitle');

  return (
    <form noValidate onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
      <DialogTitle>{title}</DialogTitle>
      <DialogDescription>{t('form.description')}</DialogDescription>

      {formError ? <Alert tone="error" title={formError} /> : null}
      {conflict ? (
        <Alert tone="warning" title={t('conflict.title')}>
          <p>{t('conflict.description')}</p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-2"
            onClick={() => void reapply()}
          >
            {t('conflict.reapply')}
          </Button>
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={fieldId('type')} className="text-sm font-medium">
            {t('form.type')}
          </label>
          <select
            id={fieldId('type')}
            aria-invalid={errorOf('type') ? true : undefined}
            aria-describedby={describe('type')}
            className={INPUT}
            {...register('type')}
          >
            <option value="">{t('form.typePlaceholder')}</option>
            {DEPARTMENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {typeLabel(type, labels, (value) => t(`types.${value}`))}
              </option>
            ))}
          </select>
          {errorText('type')}
        </div>
        {parentName !== null ? (
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">{t('form.parent')}</span>
            <span className="flex h-10 items-center text-sm text-muted-foreground">
              {parentName}
            </span>
          </div>
        ) : null}
        {text('name', { className: 'sm:col-span-2' })}
        {text('acronym', { hint: t('form.acronymHint') })}
        {text('code', { hint: t('form.codeHint') })}
        {text('email', { type: 'email' })}
        {text('phone', { type: 'tel' })}
        {text('sortOrder', { type: 'number' })}
      </div>

      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-semibold">{t('form.people')}</legend>
        {(['headUserId', 'deputyUserId'] as const).map((field) => (
          <UserLookupSelect
            key={field}
            id={fieldId(field)}
            label={t(`form.${field}`)}
            value={staff[field]}
            error={errorOf(field)}
            onClear={() => {
              setValue(field, '', { shouldDirty: true });
            }}
          />
        ))}
      </fieldset>

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onClose}>
          {t('form.cancel')}
        </Button>
        <Button type="submit" aria-busy={pending} disabled={pending}>
          {pending ? t('form.submitting') : t('form.submit')}
        </Button>
      </div>
    </form>
  );
}
