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
  Textarea,
  toast,
} from '@contrataflow/ui';
import type { SupplierDocumentType, SupplierDto } from '@contrataflow/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';

import { isApiError } from '@/lib/api/api-error';
import { newIdempotencyKey } from '@/lib/api/client';
import { useTenantId } from '@/lib/session/session-context';

import { DocumentNumberInput } from './document-number-input';
import {
  SUPPLIER_DOCUMENT_TYPES,
  buildCreateBody,
  buildPatch,
  documentProblem,
  initialValues,
  validateCreate,
  validatePatch,
} from './supplier-form-model';
import type { FormField, FormValues, RequiredField } from './supplier-form-model';
import {
  createSupplier,
  fetchSupplier,
  lookupSupplier,
  supplierKeys,
  updateSupplier,
} from './suppliers.api';

const FORM_FIELDS = new Set<string>(Object.keys(initialValues()));

export interface SupplierFormDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Fornecedor em edição; ausente = criação (SUP-02). */
  readonly supplier?: SupplierDto | undefined;
}

/**
 * `SupplierFormDialog` (SCR-107 · US-025 · passos 2–7): React Hook Form com a validação dos mesmos
 * schemas Zod da API (`createSupplierSchema`/`updateSupplierSchema`). A criação envia o corpo de
 * SUP-02 com `Idempotency-Key`; a edição envia só o que mudou, com `If-Match` — o documento é
 * imutável e fica bloqueado (FA-01); 412 oferece "Recarregar e reaplicar minhas alterações". Ao
 * sair do campo do documento confere o dígito verificador e consulta SUP-06 para avisar da
 * duplicidade. Painel lateral do kit (`Sheet`, prd-5): cabeçalho e rodapé fixos, só o corpo rola;
 * foco no primeiro campo ao abrir; tela cheia abaixo de 768 px.
 */
export function SupplierFormDialog({ open, onOpenChange, supplier }: SupplierFormDialogProps) {
  const t = useTranslations('suppliers');
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent closeLabel={t('form.close')}>
        <SupplierFormBody
          key={supplier?.id ?? 'novo'}
          supplier={supplier}
          onClose={() => {
            onOpenChange(false);
          }}
        />
      </SheetContent>
    </Sheet>
  );
}

function SupplierFormBody({
  supplier,
  onClose,
}: {
  readonly supplier: SupplierDto | undefined;
  readonly onClose: () => void;
}) {
  const t = useTranslations('suppliers');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const ids = useId();
  const [base, setBase] = useState(supplier);
  const [conflict, setConflict] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<SupplierDto | null>(null);
  // Uma chave por intenção de criar: o reenvio após falha transitória não duplica o fornecedor.
  const idempotencyKey = useRef(newIdempotencyKey());
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
  const documentType = useWatch({ control, name: 'documentType' });

  const create = useMutation({
    mutationFn: (body: ReturnType<typeof buildCreateBody>) =>
      createSupplier(body, idempotencyKey.current),
  });
  const update = useMutation({
    mutationFn: ({
      id,
      patch,
      version,
    }: {
      id: string;
      patch: ReturnType<typeof buildPatch>;
      version: number;
    }) => updateSupplier(id, patch, version),
  });

  const requiredMessage = (field: RequiredField) =>
    t('validation.required', {
      field: t(`form.${field}`)
        .replace(/\s*\*$/, '')
        .toLowerCase(),
    });

  const documentMessage = (code: 'INVALID_CNPJ' | 'INVALID_CPF' | 'TOO_LONG') =>
    t(`validation.${code}`);

  const applyServerErrors = (error: unknown): void => {
    if (!isApiError(error)) {
      setFormError(t('errors.generic'));
      return;
    }
    if (error.status === 412) {
      setConflict(true);
      return;
    }
    if (error.code === 'SUPPLIER_ALREADY_EXISTS') {
      setError('documentNumber', { message: error.message });
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
      }
    }
    if (!mapped) setFormError(error.message || t('errors.generic'));
  };

  const finish = (saved: SupplierDto, key: 'created' | 'updated'): void => {
    toast({ title: t(`toast.${key}`, { name: saved.legalName }), tone: 'success' });
    void queryClient.invalidateQueries({ queryKey: supplierKeys.all(tenantId) });
    onClose();
  };

  const onSubmit = handleSubmit(async (submitted) => {
    setFormError(null);
    if (!base) {
      const problems = validateCreate(submitted, requiredMessage);
      const problem = documentProblem(submitted.documentType, submitted.documentNumber);
      if (problem && !problems.documentNumber) problems.documentNumber = documentMessage(problem);
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

  /** 412: relê o fornecedor (SUP-03) e reaplica só os campos que a pessoa alterou. */
  const reapply = async (): Promise<void> => {
    if (!base) return;
    const mine = getValues();
    const touched = (Object.keys(dirtyFields) as FormField[]).filter((field) => dirtyFields[field]);
    try {
      const fresh = (await fetchSupplier(base.id)).data;
      setBase(fresh);
      reset(initialValues(fresh));
      for (const field of touched) setValue(field, mine[field] as never, { shouldDirty: true });
      void queryClient.invalidateQueries({ queryKey: supplierKeys.all(tenantId) });
      setConflict(false);
    } catch {
      setConflict(false);
      setFormError(t('errors.notFound'));
    }
  };

  /** Ao sair do campo com o número completo: DV (V-02/V-03) e duplicidade (SUP-06 — passo 4). */
  const checkDocument = async (type: SupplierDocumentType, value: string): Promise<void> => {
    const problem = documentProblem(type, value);
    if (problem) {
      setError('documentNumber', { message: documentMessage(problem) });
      return;
    }
    clearErrors('documentNumber');
    try {
      const found = await lookupSupplier(value);
      setDuplicate(found);
      if (found) setError('documentNumber', { message: t('validation.duplicate') });
    } catch {
      // A consulta é só um aviso antecipado: a API reconfere a duplicidade ao salvar.
      setDuplicate(null);
    }
  };

  const pending = create.isPending || update.isPending;
  const errorOf = (name: FormField) => errors[name]?.message;

  const text = (
    name: Exclude<FormField, 'documentType' | 'documentNumber' | 'isActive' | 'notes'>,
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

  return (
    <form
      noValidate
      onSubmit={(event) => void onSubmit(event)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <SheetHeader>
        <SheetTitle>
          {isEdit ? t('form.editTitle', { name: base.legalName }) : t('form.createTitle')}
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
          {duplicate ? (
            <Alert tone="warning" title={t('duplicate.title', { name: duplicate.legalName })}>
              {t('duplicate.description')}
            </Alert>
          ) : null}
        </div>

        <section className="grid gap-4 sm:grid-cols-2">
          <Field label={t('form.documentType')} error={errorOf('documentType')} disabled={isEdit}>
            <Controller
              control={control}
              name="documentType"
              render={({ field }) => (
                <Select
                  value={field.value}
                  disabled={isEdit}
                  onValueChange={(value) => {
                    field.onChange(value);
                    // Trocar o tipo descarta o número digitado (a máscara e o dígito mudam).
                    setValue('documentNumber', '');
                    clearErrors('documentNumber');
                    setDuplicate(null);
                  }}
                >
                  <SelectTrigger ref={field.ref}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SUPPLIER_DOCUMENT_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {t(`documentTypes.${type}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </Field>
          <Field
            label={t('form.documentNumber')}
            description={isEdit ? t('form.documentLocked') : t(`form.documentHint.${documentType}`)}
            error={errorOf('documentNumber')}
          >
            <Controller
              control={control}
              name="documentNumber"
              render={({ field }) => (
                <DocumentNumberInput
                  documentType={documentType}
                  value={field.value}
                  onChange={(value) => {
                    setDuplicate(null);
                    field.onChange(value);
                  }}
                  readOnly={isEdit}
                  onComplete={(value) => void checkDocument(documentType, value)}
                  onIncomplete={() => {
                    setDuplicate(null);
                    clearErrors('documentNumber');
                  }}
                />
              )}
            />
          </Field>
          {text('legalName', { className: 'sm:col-span-2' })}
          {text('tradeName', { className: 'sm:col-span-2' })}
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
          {text('email', { type: 'email' })}
          {text('phone')}
          {text('website', { hint: t('form.websiteHint') })}
          {text('contactName')}
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
        </fieldset>

        <Field label={t('form.notes')} error={errorOf('notes')}>
          <Textarea rows={3} {...register('notes')} />
        </Field>
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
