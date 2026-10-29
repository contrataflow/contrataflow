'use client';

import {
  Alert,
  Button,
  Checkbox,
  Field,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
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
 * Painel lateral (`Sheet` do kit) de criação/edição do SCR-108 (US-061 · passos 3–8): React Hook Form com a validação dos
 * mesmos schemas da API, prévia da máscara (a sequência real vem da US-105), bloco "Quem aprova" e
 * campos restritos de tipo de sistema como texto com cadeado. Edição só envia o que mudou, com
 * `If-Match`; 412 oferece "Recarregar e reaplicar minhas alterações".
 */
export function DocumentTypeForm({ open, onOpenChange, type }: DocumentTypeFormProps) {
  const t = useTranslations('documentTypes');
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent closeLabel={t('form.close')}>
        {open ? (
          <DocumentTypeFormBody
            key={type?.id ?? 'novo'}
            type={type}
            onClose={() => {
              onOpenChange(false);
            }}
          />
        ) : null}
      </SheetContent>
    </Sheet>
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
  const formId = useId();
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
  const errorOf = (name: keyof FormValues) => errors[name]?.message;
  const set = <K extends keyof FormValues>(name: K, value: FormValues[K]): void => {
    setValue(name, value as never, { shouldDirty: true });
  };

  const check = (
    name: 'allowMultiplePerProcess' | 'numberingEnabled' | 'requiresApproval' | 'allowDeputy',
    label: string,
  ) => (
    <div className="flex items-center gap-3">
      <Checkbox
        id={`${formId}-${name}`}
        checked={values[name]}
        onCheckedChange={(checked) => {
          set(name, checked === true);
        }}
      />
      <Label htmlFor={`${formId}-${name}`}>{label}</Label>
    </div>
  );

  const yesNo = (value: boolean) => (value ? t('values.yes') : t('values.no'));

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
        <div aria-live="polite" className="flex flex-col gap-3 empty:hidden">
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

        {isEdit ? (
          <>
            <LockedField label={t('form.kind')}>{t(`groups.${base.kind}`)}</LockedField>
            <LockedField label={t('form.code')}>
              <span className="font-mono">{base.code}</span>
            </LockedField>
          </>
        ) : (
          <Field group label={t('form.kind')}>
            <RadioGroup
              value={values.kind}
              onValueChange={(next) => {
                set('kind', next === 'UPLOADED' ? 'UPLOADED' : 'FREE_TEXT');
              }}
              className="flex-row flex-wrap gap-x-6"
            >
              {(['FREE_TEXT', 'UPLOADED'] as const).map((kind) => (
                <div key={kind} className="flex items-center gap-3">
                  <RadioGroupItem id={`${formId}-kind-${kind}`} value={kind} />
                  <Label htmlFor={`${formId}-kind-${kind}`}>{t(`form.kindOptions.${kind}`)}</Label>
                </div>
              ))}
            </RadioGroup>
          </Field>
        )}

        {can('name') ? (
          <Field label={t('form.name')} error={errorOf('name')}>
            <Input
              // eslint-disable-next-line jsx-a11y/no-autofocus -- foco no primeiro campo ao abrir o painel
              autoFocus
              {...register('name', {
                onChange: (event: { target: { value: string } }) => {
                  if (!isEdit && !dirtyFields.code) {
                    setValue('code', suggestedCode(event.target.value));
                  }
                },
              })}
            />
          </Field>
        ) : (
          <LockedField label={t('form.name')}>{base?.name}</LockedField>
        )}

        {isEdit ? null : (
          <Field label={t('form.code')} error={errorOf('code')} description={t('form.codeHint')}>
            <Input autoComplete="off" {...register('code')} />
          </Field>
        )}

        {can('description') ? (
          <Field label={t('form.descriptionField')} error={errorOf('description')}>
            <Textarea rows={3} {...register('description')} />
          </Field>
        ) : (
          <LockedField label={t('form.descriptionField')}>{base?.description ?? '—'}</LockedField>
        )}

        {can('allowMultiplePerProcess') ? (
          check('allowMultiplePerProcess', t('form.allowMultiple'))
        ) : (
          <LockedField label={t('form.allowMultiple')}>
            {yesNo(base?.allowMultiplePerProcess ?? false)}
          </LockedField>
        )}

        {can('numberingEnabled') ? (
          check('numberingEnabled', t('form.numberingEnabled'))
        ) : (
          <LockedField label={t('form.numberingEnabled')}>
            {yesNo(base?.numberingEnabled ?? false)}
          </LockedField>
        )}

        {can('numberingMask') ? (
          values.numberingEnabled ? (
            <div className="flex flex-col gap-1.5">
              <Field
                label={t('form.mask')}
                error={errorOf('numberingMask')}
                description={t('form.maskHint')}
              >
                <Input {...register('numberingMask')} />
              </Field>
              <p className="text-sm" aria-live="polite">
                {mask === '' ? t('form.maskDefault') : null}{' '}
                {preview ? t('form.maskPreview', { preview }) : null}
              </p>
              {isEdit ? (
                <p className="text-[0.8125rem] text-muted-foreground">
                  {t('form.maskKeepsSequence')}
                </p>
              ) : null}
            </div>
          ) : null
        ) : (
          <LockedField label={t('form.mask')}>{base?.numberingMask ?? '—'}</LockedField>
        )}

        {can('defaultConfidentiality') ? (
          <Field label={t('form.confidentiality')}>
            <Select
              value={values.defaultConfidentiality}
              onValueChange={(next) => {
                set('defaultConfidentiality', next as FormValues['defaultConfidentiality']);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['PUBLIC', 'INTERNAL', 'RESTRICTED'] as const).map((level) => (
                  <SelectItem key={level} value={level}>
                    {t(`confidentiality.${level}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : (
          <LockedField label={t('form.confidentiality')}>
            {base ? t(`confidentiality.${base.defaultConfidentiality}`) : ''}
          </LockedField>
        )}

        {can('sortOrder') ? (
          <Field label={t('form.sortOrder')} error={errorOf('sortOrder')}>
            <Input type="number" inputMode="numeric" min={0} max={999} {...register('sortOrder')} />
          </Field>
        ) : (
          <LockedField label={t('form.sortOrder')}>{base?.sortOrder}</LockedField>
        )}

        {can('requiresApproval') ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              {check('requiresApproval', t('form.requiresApproval'))}
              {errorOf('requiresApproval') ? (
                <p className="text-[0.8125rem] font-semibold text-destructive">
                  {errorOf('requiresApproval')}
                </p>
              ) : null}
            </div>
            <div aria-live="polite" className="empty:hidden">
              {values.requiresApproval ? (
                <fieldset className="m-0 flex min-w-0 flex-col gap-4 border-0 border-t border-border p-0 pt-4">
                  <legend className="float-left mb-3 w-full p-0 text-sm font-semibold">
                    {t('form.approver.legend')}
                  </legend>
                  {isEdit ? (
                    <p className="text-[0.8125rem] text-muted-foreground">
                      {t('form.approvalImpact')}
                    </p>
                  ) : null}
                  {lockedPolicy ? (
                    <p className="text-sm">{t('form.approver.locked')}</p>
                  ) : (
                    <>
                      <Field label={t('form.approver.type')}>
                        <Select value="DEPARTMENT_HEAD">
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="DEPARTMENT_HEAD">
                              {t('form.approver.typeDepartmentHead')}
                            </SelectItem>
                            <SelectItem value="USER" disabled>
                              {t('form.approver.typeUser')}
                            </SelectItem>
                            <SelectItem value="ROLE" disabled>
                              {t('form.approver.typeRole')}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field label={t('form.approver.resolution')}>
                        <Select
                          value={values.approverResolution}
                          onValueChange={(next) => {
                            set(
                              'approverResolution',
                              next === 'REQUESTING_DEPARTMENT'
                                ? 'REQUESTING_DEPARTMENT'
                                : 'REQUESTING_SECRETARIAT',
                            );
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="REQUESTING_SECRETARIAT">
                              {t('form.approver.resolutionSecretariat')}
                            </SelectItem>
                            <SelectItem value="REQUESTING_DEPARTMENT">
                              {t('form.approver.resolutionDepartment')}
                            </SelectItem>
                            <SelectItem value="FIXED" disabled>
                              {t('form.approver.resolutionFixed')}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </Field>
                      {check('allowDeputy', t('form.approver.allowDeputy'))}
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Field label={t('form.approver.sla')} error={errorOf('slaDays')}>
                          <Input
                            type="number"
                            inputMode="numeric"
                            min={1}
                            max={365}
                            {...register('slaDays')}
                          />
                        </Field>
                        <Field label={t('form.approver.slaType')}>
                          <Select
                            value={values.slaType}
                            onValueChange={(next) => {
                              set('slaType', next === 'CALENDAR' ? 'CALENDAR' : 'BUSINESS');
                            }}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="BUSINESS">
                                {t('form.approver.slaBusiness')}
                              </SelectItem>
                              <SelectItem value="CALENDAR">
                                {t('form.approver.slaCalendar')}
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        </Field>
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
