'use client';

import {
  Alert,
  Button,
  Checkbox,
  Field,
  Input,
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
  toast,
} from '@contrataflow/ui';
import { ORGANIZATION_TYPES } from '@contrataflow/validation';
import type { OrganizationDto } from '@contrataflow/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';

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
 * e reaplicar minhas alterações" (FA-05). Painel lateral do kit (`Sheet`, prd-5): cabeçalho e rodapé
 * fixos, só o corpo rola; foco no primeiro campo ao abrir; tela cheia abaixo de 768 px.
 */
export function OrganizationFormDialog({
  open,
  onOpenChange,
  organization,
}: OrganizationFormDialogProps) {
  const t = useTranslations('organizations');
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent closeLabel={t('form.close')}>
        <OrganizationFormBody
          key={organization?.id ?? 'novo'}
          organization={organization}
          onClose={() => {
            onOpenChange(false);
          }}
        />
      </SheetContent>
    </Sheet>
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
  const errorOf = (name: FormField) => errors[name]?.message;

  const text = (
    name: Exclude<FormField, 'type' | 'cnpj' | 'isActive'>,
    options: { readonly hint?: string; readonly className?: string } = {},
  ) => (
    <Field
      label={t(`form.${name}`)}
      description={options.hint}
      error={errorOf(name)}
      className={options.className}
    >
      <Input {...register(name)} />
    </Field>
  );

  return (
    <form
      noValidate
      onSubmit={(event) => void onSubmit(event)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <SheetHeader>
        <SheetTitle>
          {isEdit ? t('form.editTitle', { name: base.name }) : t('form.createTitle')}
        </SheetTitle>
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
          {text('name', { className: 'sm:col-span-2' })}
          {text('shortName', { hint: t('form.shortNameHint') })}
          <Field label={t('form.cnpj')} description={t('form.cnpjHint')} error={errorOf('cnpj')}>
            <Controller
              control={control}
              name="cnpj"
              render={({ field }) => (
                <CnpjInput
                  value={field.value}
                  onChange={field.onChange}
                  onValidated={(invalid) => {
                    if (invalid) setError('cnpj', { message: t('validation.invalidCnpj') });
                    else clearErrors('cnpj');
                  }}
                />
              )}
            />
          </Field>
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
                    {ORGANIZATION_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {t(`types.${type}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </Field>
          {isEdit ? (
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <div className="flex items-center gap-2.5">
                <Controller
                  control={control}
                  name="isActive"
                  render={({ field }) => (
                    <Checkbox
                      id={`${ids}-isActive`}
                      ref={field.ref}
                      checked={field.value}
                      aria-describedby={`${ids}-isActive-hint`}
                      onCheckedChange={(checked) => {
                        field.onChange(checked === true);
                      }}
                    />
                  )}
                />
                <Label htmlFor={`${ids}-isActive`}>{t('form.isActive')}</Label>
              </div>
              <p id={`${ids}-isActive-hint`} className="text-[0.8125rem] text-muted-foreground">
                {t('form.isActiveHint')}
              </p>
              {errorOf('isActive') ? (
                <p className="text-[0.8125rem] font-semibold text-destructive">
                  {errorOf('isActive')}
                </p>
              ) : null}
            </div>
          ) : null}
        </section>

        <fieldset className="m-0 grid gap-4 border-0 p-0 sm:grid-cols-2">
          <legend className="mb-3 text-sm font-bold text-brand-ink">{t('form.contact')}</legend>
          {text('email')}
          {text('phone')}
          {text('website', { hint: t('form.websiteHint'), className: 'sm:col-span-2' })}
        </fieldset>

        <fieldset className="m-0 grid gap-4 border-0 p-0 sm:grid-cols-6">
          <legend className="mb-3 text-sm font-bold text-brand-ink">{t('form.address')}</legend>
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
