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
import type { SupplierDocumentType, SupplierDto } from '@contrataflow/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import type { UseFormRegisterReturn } from 'react-hook-form';

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

const INPUT = 'h-10 rounded-control border border-border bg-surface px-3 text-sm';
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
 * duplicidade. Foco no primeiro campo ao abrir; erros em `aria-live`; tela cheia abaixo de 768 px.
 */
export function SupplierFormDialog({ open, onOpenChange, supplier }: SupplierFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="h-dvh max-h-dvh overflow-y-auto md:h-auto md:max-h-[90vh]"
        style={{ maxWidth: '44rem' }}
      >
        <SupplierFormBody
          key={supplier?.id ?? 'novo'}
          supplier={supplier}
          onClose={() => {
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
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
      readonly type?: string;
    } = {},
  ) => (
    <div className={`flex flex-col gap-1 ${options.className ?? ''}`}>
      <label htmlFor={fieldId(name)} className="text-sm font-medium">
        {t(`form.${name}`)}
      </label>
      <input
        id={fieldId(name)}
        type={options.type ?? 'text'}
        aria-invalid={errorOf(name) ? true : undefined}
        aria-describedby={describe(name, options.hint ? `${fieldId(name)}-hint` : undefined)}
        className={INPUT}
        {...(options.registration ?? register(name as 'legalName'))}
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
        {isEdit ? t('form.editTitle', { name: base.legalName }) : t('form.createTitle')}
      </DialogTitle>
      <DialogDescription>{t('form.description')}</DialogDescription>

      <div aria-live="polite" className="flex flex-col gap-2">
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

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={fieldId('documentType')} className="text-sm font-medium">
            {t('form.documentType')}
          </label>
          <select
            id={fieldId('documentType')}
            disabled={isEdit}
            aria-invalid={errorOf('documentType') ? true : undefined}
            aria-describedby={describe('documentType')}
            className={INPUT}
            {...register('documentType', {
              onChange: () => {
                // Trocar o tipo descarta o número digitado (a máscara e o dígito mudam).
                setValue('documentNumber', '');
                clearErrors('documentNumber');
                setDuplicate(null);
              },
            })}
          >
            {SUPPLIER_DOCUMENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`documentTypes.${type}`)}
              </option>
            ))}
          </select>
          {errorText('documentType')}
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={fieldId('documentNumber')} className="text-sm font-medium">
            {t('form.documentNumber')}
          </label>
          <Controller
            control={control}
            name="documentNumber"
            render={({ field }) => (
              <DocumentNumberInput
                id={fieldId('documentNumber')}
                documentType={documentType}
                value={field.value}
                onChange={(value) => {
                  setDuplicate(null);
                  field.onChange(value);
                }}
                readOnly={isEdit}
                invalid={Boolean(errorOf('documentNumber'))}
                describedBy={describe('documentNumber', `${fieldId('documentNumber')}-hint`)}
                onComplete={(value) => void checkDocument(documentType, value)}
                onIncomplete={() => {
                  setDuplicate(null);
                  clearErrors('documentNumber');
                }}
              />
            )}
          />
          <p id={`${fieldId('documentNumber')}-hint`} className="text-xs text-muted-foreground">
            {isEdit ? t('form.documentLocked') : t(`form.documentHint.${documentType}`)}
          </p>
          {errorText('documentNumber')}
        </div>
        {text('legalName', { className: 'sm:col-span-2' })}
        {text('tradeName', { className: 'sm:col-span-2' })}
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
        {text('email', { type: 'email' })}
        {text('phone')}
        {text('website', { hint: t('form.websiteHint') })}
        {text('contactName')}
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
      </fieldset>

      <div className="flex flex-col gap-1">
        <label htmlFor={fieldId('notes')} className="text-sm font-medium">
          {t('form.notes')}
        </label>
        <textarea
          id={fieldId('notes')}
          rows={3}
          aria-invalid={errorOf('notes') ? true : undefined}
          aria-describedby={describe('notes')}
          className="rounded-control border border-border bg-surface px-3 py-2 text-sm"
          {...register('notes')}
        />
        {errorText('notes')}
      </div>

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
