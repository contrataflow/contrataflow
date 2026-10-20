'use client';

import type { CatalogType } from '@contrataflow/types';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  toast,
} from '@contrataflow/ui';
import type { CatalogItemDto } from '@contrataflow/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMessages, useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { useTenantId } from '@/lib/session/session-context';

import {
  METADATA_FIELDS,
  buildCreateBody,
  buildPatch,
  initialValues,
  validateForm,
} from './catalog-model';
import type {
  FieldErrors,
  FormValues,
  MetadataField,
  MetadataValue,
  OptionsName,
} from './catalog-model';
import { catalogKeys, createCatalogItem, updateCatalogItem } from './catalogs.api';

const INPUT = 'h-10 rounded-control border border-border bg-surface px-3 text-sm';

export interface CatalogFormDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly catalogType: CatalogType;
  /** Item em edição; ausente = criação (CAT-02). */
  readonly item?: CatalogItemDto | undefined;
  /** 412: a lista é relida pela tela (o diálogo só avisa e fecha). */
  readonly onConflict: () => void;
}

/**
 * `CatalogItemFormDialog` (SCR-109 · US-104 · passos 3–5): campos fixos (código, rótulo, descrição)
 * e campos de `metadata` dinâmicos por `catalogType`, validados com os mesmos schemas Zod da API.
 * O código só é editável na criação e fica bloqueado depois (RN-TEN-59/60); a edição envia só o
 * que mudou, com `If-Match`. Foco no primeiro campo ao abrir; erros em `aria-live`; tela cheia
 * abaixo de 768 px.
 */
export function CatalogFormDialog({
  open,
  onOpenChange,
  catalogType,
  item,
  onConflict,
}: CatalogFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="h-dvh max-h-dvh overflow-y-auto md:h-auto md:max-h-[90vh]"
        style={{ maxWidth: '40rem' }}
      >
        <CatalogFormBody
          key={`${catalogType}:${item?.id ?? 'novo'}`}
          catalogType={catalogType}
          item={item}
          onConflict={onConflict}
          onClose={() => {
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function CatalogFormBody({
  catalogType,
  item,
  onConflict,
  onClose,
}: {
  readonly catalogType: CatalogType;
  readonly item: CatalogItemDto | undefined;
  readonly onConflict: () => void;
  readonly onClose: () => void;
}) {
  const t = useTranslations('catalogs');
  // Rótulos das opções de `metadata` são dinâmicos (lista por tipo): lidos do catálogo de mensagens.
  const allMessages = useMessages() as unknown as {
    catalogs: { options: Record<OptionsName, Record<string, string>> };
  };
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const ids = useId();
  const [values, setValues] = useState<FormValues>(() => initialValues(catalogType, item));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const isEdit = item !== undefined;

  const create = useMutation({
    mutationFn: (body: ReturnType<typeof buildCreateBody>) => createCatalogItem(catalogType, body),
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
    }) => updateCatalogItem(id, patch, version),
  });
  const pending = create.isPending || update.isPending;

  const messages = {
    required: (field: 'code' | 'label') =>
      t('validation.required', { field: t(`validation.field.${field}`) }),
    invalidCode: t('validation.invalidCode'),
    tooLong: (_field: 'label' | 'description', max: number) => t('validation.tooLong', { max }),
    metadata: t('validation.metadata'),
  };

  const applyServerErrors = (error: unknown): void => {
    if (!isApiError(error)) {
      setFormError(t('errors.generic'));
      return;
    }
    if (error.status === 412) {
      onConflict();
      onClose();
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
    const fieldErrors: Record<string, string> = {};
    for (const fieldError of error.errors) fieldErrors[fieldError.field] = fieldError.message;
    if (Object.keys(fieldErrors).length > 0) {
      setErrors(fieldErrors);
      return;
    }
    setFormError(error.message || t('errors.generic'));
  };

  const finish = (saved: CatalogItemDto, key: 'created' | 'updated'): void => {
    toast({ title: t(`toast.${key}`, { name: saved.label }), tone: 'success' });
    void queryClient.invalidateQueries({ queryKey: catalogKeys.all(tenantId) });
    onClose();
  };

  const onSubmit = async (): Promise<void> => {
    setFormError(null);
    const problems = validateForm(catalogType, values, isEdit ? 'edit' : 'create', messages);
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    try {
      if (item) {
        const patch = buildPatch(catalogType, values, item);
        if (Object.keys(patch).length === 0) {
          onClose();
          return;
        }
        const result = await update.mutateAsync({ id: item.id, patch, version: item.version });
        finish(result.data, 'updated');
      } else {
        const result = await create.mutateAsync(buildCreateBody(catalogType, values));
        finish(result.data, 'created');
      }
    } catch (error) {
      applyServerErrors(error);
    }
  };

  const fieldId = (name: string) => `${ids}-${name}`;
  const errorText = (name: string) =>
    errors[name] ? (
      <p id={`${fieldId(name)}-error`} className="text-sm text-destructive" aria-live="polite">
        {errors[name]}
      </p>
    ) : null;
  const describedBy = (name: string, hint?: string) =>
    [
      errors[name] ? `${fieldId(name)}-error` : undefined,
      hint ? `${fieldId(name)}-hint` : undefined,
    ]
      .filter(Boolean)
      .join(' ') || undefined;

  const setMetadata = (name: string, value: MetadataValue): void => {
    setValues((current) => ({ ...current, metadata: { ...current.metadata, [name]: value } }));
  };

  const optionLabel = (name: OptionsName, option: string): string =>
    allMessages.catalogs.options[name][option] ?? option;

  const metadataControl = (field: MetadataField) => {
    const name = `metadata.${field.name}`;
    const value = values.metadata[field.name];
    const label = t(`metadata.${field.name}`);
    const common = {
      id: fieldId(name),
      'aria-invalid': errors[name] ? true : undefined,
      'aria-describedby': describedBy(name, field.kind === 'color' ? 'hint' : undefined),
    } as const;
    switch (field.kind) {
      case 'boolean':
        return (
          <div key={field.name} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <input
                {...common}
                type="checkbox"
                className="size-4"
                checked={value === true}
                onChange={(event) => {
                  setMetadata(field.name, event.target.checked);
                }}
              />
              <label htmlFor={fieldId(name)} className="text-sm font-medium">
                {label}
              </label>
            </div>
            {errorText(name)}
          </div>
        );
      case 'multi': {
        const selected = Array.isArray(value) ? (value as readonly string[]) : [];
        return (
          <fieldset
            key={field.name}
            className="flex flex-col gap-1"
            aria-describedby={describedBy(name)}
          >
            <legend className="text-sm font-medium">{label}</legend>
            <div className="grid gap-1 sm:grid-cols-2">
              {field.options.map((option) => (
                <label key={option} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={selected.includes(option)}
                    onChange={(event) => {
                      setMetadata(
                        field.name,
                        event.target.checked
                          ? [...selected, option]
                          : selected.filter((entry) => entry !== option),
                      );
                    }}
                  />
                  {optionLabel(field.name, option)}
                </label>
              ))}
            </div>
            {errorText(name)}
          </fieldset>
        );
      }
      case 'select':
        return (
          <div key={field.name} className="flex flex-col gap-1">
            <label htmlFor={fieldId(name)} className="text-sm font-medium">
              {label}
            </label>
            <select
              {...common}
              className={INPUT}
              value={typeof value === 'string' ? value : ''}
              onChange={(event) => {
                setMetadata(field.name, event.target.value);
              }}
            >
              <option value="">{t('form.selectPlaceholder')}</option>
              {field.options.map((option) => (
                <option key={option} value={option}>
                  {optionLabel(field.name, option)}
                </option>
              ))}
            </select>
            {errorText(name)}
          </div>
        );
      default:
        return (
          <div key={field.name} className="flex flex-col gap-1">
            <label htmlFor={fieldId(name)} className="text-sm font-medium">
              {label}
            </label>
            <input
              {...common}
              type={field.kind === 'number' ? 'number' : 'text'}
              {...(field.kind === 'number' ? { min: 1, step: 1 } : {})}
              {...(field.kind === 'color' ? { placeholder: '#005BF9', maxLength: 7 } : {})}
              className={INPUT}
              value={typeof value === 'string' ? value : ''}
              onChange={(event) => {
                setMetadata(field.name, event.target.value);
              }}
            />
            {field.kind === 'color' ? (
              <p id={`${fieldId(name)}-hint`} className="text-xs text-muted-foreground">
                {t('form.color.hint')}
              </p>
            ) : null}
            {errorText(name)}
          </div>
        );
    }
  };

  const fields = METADATA_FIELDS[catalogType];

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit();
      }}
      className="flex flex-col gap-4"
    >
      <DialogTitle>
        {isEdit
          ? t('form.editTitle', { name: item.label })
          : t('form.createTitle', { catalog: t(`types.${catalogType}`) })}
      </DialogTitle>
      <DialogDescription>{t('form.description')}</DialogDescription>

      {formError ? <Alert tone="error" title={formError} /> : null}

      <div className="flex flex-col gap-1">
        <label htmlFor={fieldId('code')} className="text-sm font-medium">
          {t('form.code')}
        </label>
        <input
          id={fieldId('code')}
          className={INPUT}
          value={values.code}
          readOnly={isEdit}
          aria-readonly={isEdit ? true : undefined}
          aria-invalid={errors.code ? true : undefined}
          aria-describedby={describedBy('code', 'hint')}
          autoComplete="off"
          onChange={(event) => {
            setValues((current) => ({ ...current, code: event.target.value }));
          }}
        />
        <p id={`${fieldId('code')}-hint`} className="text-xs text-muted-foreground">
          {isEdit
            ? item.isSystem
              ? t('form.codeLockedSystem')
              : t('form.codeLocked')
            : t('form.codeHint')}
        </p>
        {errorText('code')}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={fieldId('label')} className="text-sm font-medium">
          {t('form.label')}
        </label>
        <input
          id={fieldId('label')}
          className={INPUT}
          value={values.label}
          aria-invalid={errors.label ? true : undefined}
          aria-describedby={describedBy('label', 'hint')}
          onChange={(event) => {
            setValues((current) => ({ ...current, label: event.target.value }));
          }}
        />
        <p id={`${fieldId('label')}-hint`} className="text-xs text-muted-foreground">
          {t('form.labelHint')}
        </p>
        {errorText('label')}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={fieldId('description')} className="text-sm font-medium">
          {t('form.descriptionField')}
        </label>
        <textarea
          id={fieldId('description')}
          rows={3}
          className="rounded-control border border-border bg-surface px-3 py-2 text-sm"
          value={values.description}
          aria-invalid={errors.description ? true : undefined}
          aria-describedby={describedBy('description', 'hint')}
          onChange={(event) => {
            setValues((current) => ({ ...current, description: event.target.value }));
          }}
        />
        <p id={`${fieldId('description')}-hint`} className="text-xs text-muted-foreground">
          {t('form.descriptionHint')}
        </p>
        {errorText('description')}
      </div>

      {fields.length > 0 ? (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-semibold">{t('form.metadataLegend')}</legend>
          {fields.map(metadataControl)}
        </fieldset>
      ) : null}

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
