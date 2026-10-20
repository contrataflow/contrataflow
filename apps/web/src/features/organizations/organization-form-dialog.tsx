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
import { ORGANIZATION_TYPES } from '@contrataflow/validation';
import type { OrganizationDto } from '@contrataflow/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import type { UseFormRegisterReturn } from 'react-hook-form';

import { isApiError } from '@/lib/api/api-error';
import { useTenantId } from '@/lib/session/session-context';

import { CnpjInput } from './cnpj-input';
import {
  buildCreateBody,
  buildPatch,
  initialValues,
  validateCreate,
  validatePatch,
} from './organization-form-model';
import type { FormField, FormValues, RequiredField } from './organization-form-model';
import {
  createOrganization,
  fetchOrganization,
  organizationKeys,
  updateOrganization,
} from './organizations.api';

const INPUT = 'h-10 rounded-control border border-border bg-surface px-3 text-sm';
const FORM_FIELDS = new Set<string>(Object.keys(initialValues()));

export interface OrganizationFormDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Órgão em edição; ausente = criação (ORG-02). */
  readonly organization?: OrganizationDto | undefined;
}

/**
 * `OrganizationFormDialog` (SCR-032 · US-101 · passos 3–8): React Hook Form com a validação dos
 * mesmos schemas Zod da API (`createOrganizationSchema`/`updateOrganizationSchema`). A criação
 * envia o corpo de ORG-02; a edição envia só o que mudou, com `If-Match`; 412 oferece "Recarregar
 * e reaplicar minhas alterações" (FA-05). Foco no primeiro campo ao abrir; erros em `aria-live`;
 * tela cheia abaixo de 768 px.
 */
export function OrganizationFormDialog({
  open,
  onOpenChange,
  organization,
}: OrganizationFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="h-dvh max-h-dvh overflow-y-auto md:h-auto md:max-h-[90vh]"
        style={{ maxWidth: '44rem' }}
      >
        <OrganizationFormBody
          key={organization?.id ?? 'novo'}
          organization={organization}
          onClose={() => {
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function OrganizationFormBody({
  organization,
  onClose,
}: {
  readonly organization: OrganizationDto | undefined;
  readonly onClose: () => void;
}) {
  const t = useTranslations('organizations');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const ids = useId();
  const [base, setBase] = useState(organization);
  const [conflict, setConflict] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const isEdit = base !== undefined;

  const {
    register,
    handleSubmit,
    setError,
    clearErrors,
    setValue,
    getValues,
    control,
    reset,
    formState: { errors, dirtyFields },
  } = useForm<FormValues>({ defaultValues: initialValues(base) });

  const create = useMutation({ mutationFn: createOrganization });
  const update = useMutation({
    mutationFn: ({
      id,
      patch,
      version,
    }: {
      id: string;
      patch: ReturnType<typeof buildPatch>;
      version: number;
    }) => updateOrganization(id, patch, version),
  });

  const requiredMessage = (field: RequiredField) =>
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
    if (error.code === 'PRIMARY_ORGANIZATION_REQUIRED') {
      setError('isActive', { message: error.message });
      return;
    }
    if (error.code === 'MFA_REQUIRED') {
      setFormError(t('errors.mfa'));
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
        setError(fieldError.field as FormField, { message: fieldError.message });
        mapped = true;
      } else if (fieldError.field === 'logoAttachmentId') {
        setFormError(fieldError.message);
        mapped = true;
      }
    }
    if (!mapped) setFormError(error.message || t('errors.generic'));
  };

  const finish = (saved: OrganizationDto, key: 'created' | 'updated'): void => {
    toast({ title: t(`toast.${key}`, { name: saved.name }), tone: 'success' });
    void queryClient.invalidateQueries({ queryKey: organizationKeys.all(tenantId) });
    onClose();
  };

  const onSubmit = handleSubmit(async (submitted) => {
    setFormError(null);
    if (!base) {
      const problems = validateCreate(submitted, requiredMessage);
      const fields = Object.keys(problems) as FormField[];
      if (fields.length > 0) {
        for (const field of fields) setError(field, { message: problems[field] ?? '' });
        return;
      }
      try {
        const result = await create.mutateAsync(buildCreateBody(submitted));
        finish(result.data, 'created');
      } catch (error) {
        applyServerErrors(error);
      }
      return;
    }
    const patch = buildPatch(submitted, base);
    const problems = validatePatch(patch, requiredMessage);
    const fields = Object.keys(problems) as FormField[];
    if (fields.length > 0) {
      for (const field of fields) setError(field, { message: problems[field] ?? '' });
      return;
    }
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    try {
      const result = await update.mutateAsync({ id: base.id, patch, version: base.version });
      finish(result.data, 'updated');
    } catch (error) {
      applyServerErrors(error);
    }
  });

  /** 412: relê o órgão (ORG-03) e reaplica só os campos que a pessoa alterou (FA-05). */
  const reapply = async (): Promise<void> => {
    if (!base) return;
    const mine = getValues();
    const touched = (Object.keys(dirtyFields) as FormField[]).filter((field) => dirtyFields[field]);
    try {
      const fresh = (await fetchOrganization(base.id)).data;
      setBase(fresh);
      reset(initialValues(fresh));
      for (const field of touched) setValue(field, mine[field] as never, { shouldDirty: true });
      void queryClient.invalidateQueries({ queryKey: organizationKeys.all(tenantId) });
      setConflict(false);
    } catch {
      setConflict(false);
      setFormError(t('errors.notFound'));
    }
  };

  const pending = create.isPending || update.isPending;
  const fieldId = (name: string) => `${ids}-${name}`;
  const errorOf = (name: FormField) => errors[name]?.message;
  const describe = (name: FormField, extra?: string) => {
    const parts = [errorOf(name) ? `${fieldId(name)}-error` : undefined, extra].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : undefined;
  };

  const errorText = (name: FormField) =>
    errorOf(name) ? (
      <p id={`${fieldId(name)}-error`} className="text-sm text-destructive" aria-live="polite">
        {errorOf(name)}
      </p>
    ) : null;

  const text = (
    name: FormField,
    options: {
      readonly registration?: UseFormRegisterReturn;
      readonly hint?: string;
      readonly className?: string;
    } = {},
  ) => (
    <div className={`flex flex-col gap-1 ${options.className ?? ''}`}>
      <label htmlFor={fieldId(name)} className="text-sm font-medium">
        {t(`form.${name}`)}
      </label>
      <input
        id={fieldId(name)}
        aria-invalid={errorOf(name) ? true : undefined}
        aria-describedby={describe(name, options.hint ? `${fieldId(name)}-hint` : undefined)}
        className={INPUT}
        {...(options.registration ?? register(name as 'name'))}
      />
      {options.hint ? (
        <p id={`${fieldId(name)}-hint`} className="text-xs text-muted-foreground">
          {options.hint}
        </p>
      ) : null}
      {errorText(name)}
    </div>
  );

  return (
    <form noValidate onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
      <DialogTitle>
        {isEdit ? t('form.editTitle', { name: base.name }) : t('form.createTitle')}
      </DialogTitle>
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
        {text('name', { className: 'sm:col-span-2' })}
        {text('shortName', { hint: t('form.shortNameHint') })}
        <div className="flex flex-col gap-1">
          <label htmlFor={fieldId('cnpj')} className="text-sm font-medium">
            {t('form.cnpj')}
          </label>
          <Controller
            control={control}
            name="cnpj"
            render={({ field }) => (
              <CnpjInput
                id={fieldId('cnpj')}
                value={field.value}
                onChange={field.onChange}
                invalid={Boolean(errorOf('cnpj'))}
                describedBy={describe('cnpj', `${fieldId('cnpj')}-hint`)}
                onValidated={(invalid) => {
                  if (invalid) setError('cnpj', { message: t('validation.invalidCnpj') });
                  else clearErrors('cnpj');
                }}
              />
            )}
          />
          <p id={`${fieldId('cnpj')}-hint`} className="text-xs text-muted-foreground">
            {t('form.cnpjHint')}
          </p>
          {errorText('cnpj')}
        </div>
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
            {ORGANIZATION_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`types.${type}`)}
              </option>
            ))}
          </select>
          {errorText('type')}
        </div>
        {isEdit ? (
          <div className="flex flex-col gap-1 sm:col-span-2">
            <div className="flex items-center gap-2">
              <input
                id={fieldId('isActive')}
                type="checkbox"
                className="size-4"
                aria-describedby={describe('isActive', `${fieldId('isActive')}-hint`)}
                {...register('isActive')}
              />
              <label htmlFor={fieldId('isActive')} className="text-sm font-medium">
                {t('form.isActive')}
              </label>
            </div>
            <p id={`${fieldId('isActive')}-hint`} className="text-xs text-muted-foreground">
              {t('form.isActiveHint')}
            </p>
            {errorText('isActive')}
          </div>
        ) : null}
      </div>

      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-1 text-sm font-semibold">{t('form.contact')}</legend>
        {text('email')}
        {text('phone')}
        {text('website', { hint: t('form.websiteHint'), className: 'sm:col-span-2' })}
      </fieldset>

      <fieldset className="grid gap-3 sm:grid-cols-6">
        <legend className="mb-1 text-sm font-semibold">{t('form.address')}</legend>
        {text('addressStreet', { className: 'sm:col-span-4' })}
        {text('addressNumber', { className: 'sm:col-span-2' })}
        {text('addressComplement', { className: 'sm:col-span-3' })}
        {text('addressDistrict', { className: 'sm:col-span-3' })}
        {text('addressCity', { className: 'sm:col-span-3' })}
        {text('addressState', { className: 'sm:col-span-1' })}
        {text('addressZipCode', { className: 'sm:col-span-2' })}
        {text('ibgeCityCode', { className: 'sm:col-span-3' })}
      </fieldset>

      <p className="text-sm text-muted-foreground">
        <span className="font-medium">{t('form.logo')}:</span> {t('form.logoPending')}
      </p>

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
