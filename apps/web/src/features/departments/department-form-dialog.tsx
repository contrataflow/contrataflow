'use client';

import {
  Alert,
  Button,
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
  toast,
} from '@contrataflow/ui';
import { DEPARTMENT_TYPES } from '@contrataflow/validation';
import type { DepartmentDto } from '@contrataflow/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';

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
 * reaplicar minhas alterações". Painel lateral do kit (`Sheet`, prd-5): cabeçalho e rodapé fixos, só
 * o corpo rola; foco no primeiro campo; tela cheia abaixo de 768 px.
 */
export function DepartmentFormDialog({
  target,
  organizationId,
  labels,
  onClose,
}: DepartmentFormDialogProps) {
  const t = useTranslations('departments');
  const key =
    target === null
      ? 'fechado'
      : target.mode === 'edit'
        ? target.department.id
        : `novo-${target.parent?.id ?? 'raiz'}`;
  return (
    <Sheet
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent closeLabel={t('form.close')}>
        {target ? (
          <DepartmentFormBody
            key={key}
            target={target}
            organizationId={organizationId}
            labels={labels}
            onClose={onClose}
          />
        ) : null}
      </SheetContent>
    </Sheet>
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
  const errorOf = (name: DepartmentFormField) => errors[name]?.message;
  const text = (
    name: Exclude<DepartmentFormField, 'type' | 'headUserId' | 'deputyUserId'>,
    options: { readonly hint?: string; readonly className?: string; readonly type?: string } = {},
  ) => (
    <Field
      label={t(`form.${name}`)}
      description={options.hint}
      error={errorOf(name)}
      className={options.className}
    >
      <Input type={options.type ?? 'text'} {...register(name)} />
    </Field>
  );

  const parentName = base ? null : (parent?.name ?? t('form.root'));
  const title = base
    ? t('form.editTitle', { name: base.name })
    : parent
      ? t('form.createChildTitle', { parent: parent.name })
      : t('form.createTitle');

  return (
    <form
      noValidate
      onSubmit={(event) => void onSubmit(event)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <SheetHeader>
        <SheetTitle>{title}</SheetTitle>
        <SheetDescription>{t('form.description')}</SheetDescription>
      </SheetHeader>

      <SheetBody>
        <div aria-live="polite" className="flex flex-col gap-2 empty:hidden">
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
        </div>

        <section className="grid gap-4 sm:grid-cols-2">
          <Field label={t('form.type')} error={errorOf('type')}>
            <Controller
              control={control}
              name="type"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger ref={field.ref}>
                    <SelectValue placeholder={t('form.typePlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    {DEPARTMENT_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {typeLabel(type, labels, (value) => t(`types.${value}`))}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </Field>
          {parentName !== null ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-foreground">{t('form.parent')}</span>
              <span className="flex min-h-11 items-center text-sm text-muted-foreground">
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
        </section>

        <fieldset className="m-0 grid gap-4 border-0 p-0">
          <legend className="mb-3 text-sm font-bold text-brand-ink">{t('form.people')}</legend>
          {(['headUserId', 'deputyUserId'] as const).map((field) => (
            <UserLookupSelect
              key={field}
              label={t(`form.${field}`)}
              value={staff[field]}
              error={errorOf(field)}
              onClear={() => {
                setValue(field, '', { shouldDirty: true });
              }}
            />
          ))}
        </fieldset>
      </SheetBody>

      <SheetFooter>
        <Button type="button" variant="secondary" onClick={onClose}>
          {t('form.cancel')}
        </Button>
        <Button type="submit" aria-busy={pending} disabled={pending}>
          {pending ? t('form.submitting') : t('form.submit')}
        </Button>
      </SheetFooter>
    </form>
  );
}
