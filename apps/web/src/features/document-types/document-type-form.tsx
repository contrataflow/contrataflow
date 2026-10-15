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
import {
  DEFAULT_DOCUMENT_NUMBERING_MASK,
  numberingMaskProblem,
  renderNumberingMask,
} from '@contrataflow/validation';
import type { DocumentTypeCreate, DocumentTypeDto } from '@contrataflow/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import type { UseFormRegisterReturn } from 'react-hook-form';

import { isApiError } from '@/lib/api/api-error';
import { useIdempotentMutation } from '@/lib/api/use-idempotent-mutation';
import { useTenantId } from '@/lib/session/session-context';

import {
  buildCreateBody,
  buildPatch,
  formFieldOf,
  initialValues,
  isEditablePolicy,
  suggestedCode,
  validateCreate,
  validatePatch,
} from './document-type-form-model';
import type { FormValues } from './document-type-form-model';
import {
  createDocumentType,
  documentTypeKeys,
  fetchDocumentTypes,
  updateDocumentType,
} from './document-types.api';
import { LockedField } from './locked-field';

const INPUT = 'h-10 rounded-control border border-border bg-surface px-3 text-sm';

export interface DocumentTypeFormProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Tipo em edição; ausente = criação (DTY-02). */
  readonly type?: DocumentTypeDto | undefined;
}

function currentYear(): number {
  return new Date().getFullYear();
}

/**
 * Painel de criação/edição do SCR-108 (US-061 · passos 3–8): React Hook Form com a validação dos
 * mesmos schemas da API, prévia da máscara (a sequência real vem da US-105), bloco "Quem aprova" e
 * campos restritos de tipo de sistema como texto com cadeado. Edição só envia o que mudou, com
 * `If-Match`; 412 oferece "Recarregar e reaplicar minhas alterações".
 */
export function DocumentTypeForm({ open, onOpenChange, type }: DocumentTypeFormProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto" style={{ maxWidth: '42rem' }}>
        <DocumentTypeFormBody
          key={type?.id ?? 'novo'}
          type={type}
          onClose={() => {
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function DocumentTypeFormBody({
  type,
  onClose,
}: {
  readonly type: DocumentTypeDto | undefined;
  readonly onClose: () => void;
}) {
  const t = useTranslations('documentTypes');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const ids = useId();
  const [base, setBase] = useState(type);
  const [conflict, setConflict] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const isEdit = base !== undefined;
  const editable = new Set<string>(base?.editableFields ?? []);
  const can = (field: string) => !isEdit || editable.has(field);

  const {
    register,
    handleSubmit,
    setError,
    setValue,
    getValues,
    control,
    reset,
    formState: { errors, dirtyFields },
  } = useForm<FormValues>({ defaultValues: initialValues(base) });
  const watched = useWatch({ control });
  const values: FormValues = { ...initialValues(base), ...watched };
  const lockedPolicy = isEdit && !isEditablePolicy(base.approvalPolicy);

  const create = useIdempotentMutation({
    mutationFn: (body: DocumentTypeCreate, context) => createDocumentType(body, context),
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
    }) => updateDocumentType(id, patch, version),
  });

  const maskMessage = t('form.maskInvalid');
  const mask = values.numberingMask.trim();
  const maskIsValid = mask !== '' && numberingMaskProblem(mask) === null;
  const preview = values.numberingEnabled
    ? renderNumberingMask({
        mask: maskIsValid ? mask : DEFAULT_DOCUMENT_NUMBERING_MASK,
        typeCode: values.code.trim() === '' ? 'TIPO' : values.code.trim(),
        sequence: 1,
        year: currentYear(),
      })
    : null;

  const applyServerErrors = (error: unknown): void => {
    if (!isApiError(error)) {
      setFormError(t('errors.generic'));
      return;
    }
    if (error.status === 412) {
      setConflict(true);
      return;
    }
    if (error.status === 409 && error.code === 'CONFLICT' && !isEdit) {
      setError('code', { message: t('errors.codeTaken', { code: values.code.trim() }) });
      return;
    }
    if (error.code === 'NUMBERING_MASK_INVALID') {
      setError('numberingMask', { message: maskMessage });
      return;
    }
    if (error.code === 'APPROVER_UNRESOLVED') {
      setError('requiresApproval', { message: error.message });
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
      const field = formFieldOf(fieldError.field);
      if (field) {
        setError(field, { message: fieldError.message });
        mapped = true;
      }
    }
    if (!mapped) setFormError(error.message || t('errors.generic'));
  };

  const finish = (saved: DocumentTypeDto, key: 'created' | 'updated'): void => {
    toast({ title: t(`toast.${key}`, { name: saved.name }), tone: 'success' });
    void queryClient.invalidateQueries({ queryKey: documentTypeKeys.all(tenantId) });
    onClose();
  };

  const onSubmit = handleSubmit(async (submitted) => {
    setFormError(null);
    if (!base) {
      const problems = validateCreate(submitted, maskMessage);
      const fields = Object.keys(problems) as (keyof FormValues)[];
      if (fields.length > 0) {
        for (const field of fields) setError(field, { message: problems[field] ?? '' });
        return;
      }
      try {
        const result = await create.submit(buildCreateBody(submitted) as DocumentTypeCreate);
        finish(result.data, 'created');
      } catch (error) {
        applyServerErrors(error);
      }
      return;
    }
    const patch = buildPatch(submitted, dirtyFields, base);
    const problems = validatePatch(submitted, patch, maskMessage);
    const fields = Object.keys(problems) as (keyof FormValues)[];
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

  /** 412: relê o tipo e reaplica só os campos que a pessoa alterou (DEC-104). */
  const reapply = async (): Promise<void> => {
    if (!base) return;
    const mine = getValues();
    const touched = (Object.keys(dirtyFields) as (keyof FormValues)[]).filter(
      (field) => dirtyFields[field],
    );
    const fresh = (await fetchDocumentTypes()).data.find((item) => item.id === base.id);
    if (!fresh) {
      setConflict(false);
      setFormError(t('errors.notFound'));
      return;
    }
    setBase(fresh);
    reset(initialValues(fresh));
    for (const field of touched) {
      setValue(field, mine[field] as never, { shouldDirty: true });
    }
    void queryClient.invalidateQueries({ queryKey: documentTypeKeys.all(tenantId) });
    setConflict(false);
  };

  const pending = create.isPending || update.isPending;
  const fieldId = (name: string) => `${ids}-${name}`;
  const errorOf = (name: keyof FormValues) => errors[name]?.message;
  const describe = (name: keyof FormValues, extra?: string) => {
    const parts = [errorOf(name) ? `${fieldId(name)}-error` : undefined, extra].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : undefined;
  };

  const text = (
    name: keyof FormValues,
    label: string,
    options: { readonly registration?: UseFormRegisterReturn; readonly hint?: string } = {},
  ) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={fieldId(name)} className="text-sm font-medium">
        {label}
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
      {errorOf(name) ? (
        <p id={`${fieldId(name)}-error`} className="text-sm text-destructive">
          {errorOf(name)}
        </p>
      ) : null}
    </div>
  );

  const toggle = (
    name: 'allowMultiplePerProcess' | 'numberingEnabled' | 'requiresApproval' | 'allowDeputy',
    label: string,
  ) => (
    <div className="flex items-center gap-2">
      <input id={fieldId(name)} type="checkbox" className="size-4" {...register(name)} />
      <label htmlFor={fieldId(name)} className="text-sm font-medium">
        {label}
      </label>
    </div>
  );

  const yesNo = (value: boolean) => (value ? t('values.yes') : t('values.no'));

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

      {isEdit ? (
        <>
          <LockedField label={t('form.kind')}>{t(`groups.${base.kind}`)}</LockedField>
          <LockedField label={t('form.code')}>
            <span className="font-mono">{base.code}</span>
          </LockedField>
        </>
      ) : (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">{t('form.kind')}</legend>
          <div className="flex gap-4">
            {(['FREE_TEXT', 'UPLOADED'] as const).map((kind) => (
              <label key={kind} className="flex items-center gap-2 text-sm">
                <input type="radio" value={kind} {...register('kind')} />
                {t(`form.kindOptions.${kind}`)}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {can('name') ? (
        text('name', t('form.name'), {
          registration: register('name', {
            onChange: (event: { target: { value: string } }) => {
              if (!isEdit && !dirtyFields.code) {
                setValue('code', suggestedCode(event.target.value));
              }
            },
          }),
        })
      ) : (
        <LockedField label={t('form.name')}>{base?.name}</LockedField>
      )}

      {isEdit ? null : text('code', t('form.code'), { hint: t('form.codeHint') })}

      {can('description') ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={fieldId('description')} className="text-sm font-medium">
            {t('form.descriptionField')}
          </label>
          <textarea
            id={fieldId('description')}
            rows={3}
            aria-invalid={errorOf('description') ? true : undefined}
            aria-describedby={describe('description')}
            className="rounded-control border border-border bg-surface px-3 py-2 text-sm"
            {...register('description')}
          />
          {errorOf('description') ? (
            <p id={`${fieldId('description')}-error`} className="text-sm text-destructive">
              {errorOf('description')}
            </p>
          ) : null}
        </div>
      ) : (
        <LockedField label={t('form.descriptionField')}>{base?.description ?? '—'}</LockedField>
      )}

      {can('allowMultiplePerProcess') ? (
        toggle('allowMultiplePerProcess', t('form.allowMultiple'))
      ) : (
        <LockedField label={t('form.allowMultiple')}>
          {yesNo(base?.allowMultiplePerProcess ?? false)}
        </LockedField>
      )}

      {can('numberingEnabled') ? (
        toggle('numberingEnabled', t('form.numberingEnabled'))
      ) : (
        <LockedField label={t('form.numberingEnabled')}>
          {yesNo(base?.numberingEnabled ?? false)}
        </LockedField>
      )}

      {can('numberingMask') ? (
        values.numberingEnabled ? (
          <div className="flex flex-col gap-1">
            {text('numberingMask', t('form.mask'), { hint: t('form.maskHint') })}
            <p className="text-sm" aria-live="polite">
              {mask === '' ? t('form.maskDefault') : null}{' '}
              {preview ? t('form.maskPreview', { preview }) : null}
            </p>
            {isEdit ? (
              <p className="text-xs text-muted-foreground">{t('form.maskKeepsSequence')}</p>
            ) : null}
          </div>
        ) : null
      ) : (
        <LockedField label={t('form.mask')}>{base?.numberingMask ?? '—'}</LockedField>
      )}

      {can('defaultConfidentiality') ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={fieldId('defaultConfidentiality')} className="text-sm font-medium">
            {t('form.confidentiality')}
          </label>
          <select
            id={fieldId('defaultConfidentiality')}
            className={INPUT}
            {...register('defaultConfidentiality')}
          >
            {(['PUBLIC', 'INTERNAL', 'RESTRICTED'] as const).map((level) => (
              <option key={level} value={level}>
                {t(`confidentiality.${level}`)}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <LockedField label={t('form.confidentiality')}>
          {base ? t(`confidentiality.${base.defaultConfidentiality}`) : ''}
        </LockedField>
      )}

      {can('sortOrder') ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={fieldId('sortOrder')} className="text-sm font-medium">
            {t('form.sortOrder')}
          </label>
          <input
            id={fieldId('sortOrder')}
            type="number"
            inputMode="numeric"
            min={0}
            max={999}
            aria-invalid={errorOf('sortOrder') ? true : undefined}
            aria-describedby={describe('sortOrder')}
            className={INPUT}
            {...register('sortOrder')}
          />
          {errorOf('sortOrder') ? (
            <p id={`${fieldId('sortOrder')}-error`} className="text-sm text-destructive">
              {errorOf('sortOrder')}
            </p>
          ) : null}
        </div>
      ) : (
        <LockedField label={t('form.sortOrder')}>{base?.sortOrder}</LockedField>
      )}

      {can('requiresApproval') ? (
        <div className="flex flex-col gap-3">
          {toggle('requiresApproval', t('form.requiresApproval'))}
          {errorOf('requiresApproval') ? (
            <p id={`${fieldId('requiresApproval')}-error`} className="text-sm text-destructive">
              {errorOf('requiresApproval')}
            </p>
          ) : null}
          <div aria-live="polite">
            {values.requiresApproval ? (
              <fieldset className="flex flex-col gap-3 rounded-card border border-border p-4">
                <legend className="px-1 text-sm font-medium">{t('form.approver.legend')}</legend>
                {isEdit ? (
                  <p className="text-xs text-muted-foreground">{t('form.approvalImpact')}</p>
                ) : null}
                {lockedPolicy ? (
                  <p className="text-sm">{t('form.approver.locked')}</p>
                ) : (
                  <>
                    <div className="flex flex-col gap-1">
                      <label htmlFor={fieldId('approverType')} className="text-sm font-medium">
                        {t('form.approver.type')}
                      </label>
                      <select
                        id={fieldId('approverType')}
                        className={INPUT}
                        defaultValue="DEPARTMENT_HEAD"
                      >
                        <option value="DEPARTMENT_HEAD">
                          {t('form.approver.typeDepartmentHead')}
                        </option>
                        <option value="USER" disabled>
                          {t('form.approver.typeUser')}
                        </option>
                        <option value="ROLE" disabled>
                          {t('form.approver.typeRole')}
                        </option>
                      </select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label
                        htmlFor={fieldId('approverResolution')}
                        className="text-sm font-medium"
                      >
                        {t('form.approver.resolution')}
                      </label>
                      <select
                        id={fieldId('approverResolution')}
                        className={INPUT}
                        {...register('approverResolution')}
                      >
                        <option value="REQUESTING_SECRETARIAT">
                          {t('form.approver.resolutionSecretariat')}
                        </option>
                        <option value="REQUESTING_DEPARTMENT">
                          {t('form.approver.resolutionDepartment')}
                        </option>
                        <option value="FIXED" disabled>
                          {t('form.approver.resolutionFixed')}
                        </option>
                      </select>
                    </div>
                    {toggle('allowDeputy', t('form.approver.allowDeputy'))}
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="flex flex-col gap-1">
                        <label htmlFor={fieldId('slaDays')} className="text-sm font-medium">
                          {t('form.approver.sla')}
                        </label>
                        <input
                          id={fieldId('slaDays')}
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={365}
                          aria-invalid={errorOf('slaDays') ? true : undefined}
                          aria-describedby={describe('slaDays')}
                          className={INPUT}
                          {...register('slaDays')}
                        />
                        {errorOf('slaDays') ? (
                          <p
                            id={`${fieldId('slaDays')}-error`}
                            className="text-sm text-destructive"
                          >
                            {errorOf('slaDays')}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex flex-col gap-1">
                        <label htmlFor={fieldId('slaType')} className="text-sm font-medium">
                          {t('form.approver.slaType')}
                        </label>
                        <select id={fieldId('slaType')} className={INPUT} {...register('slaType')}>
                          <option value="BUSINESS">{t('form.approver.slaBusiness')}</option>
                          <option value="CALENDAR">{t('form.approver.slaCalendar')}</option>
                        </select>
                      </div>
                    </div>
                  </>
                )}
              </fieldset>
            ) : null}
          </div>
        </div>
      ) : (
        <LockedField label={t('form.requiresApproval')}>
          {yesNo(base?.requiresApproval ?? false)}
        </LockedField>
      )}

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
