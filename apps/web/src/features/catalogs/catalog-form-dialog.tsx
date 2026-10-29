'use client';

import type { CatalogType } from '@contrataflow/types';
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
import type { CatalogItemDto } from '@contrataflow/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMessages, useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import type { SyntheticEvent } from 'react';

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

/** O `Select` do kit não aceita valor vazio: "Não informado" usa este marcador. */
const NONE = 'none';

export interface CatalogFormDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly catalogType: CatalogType;
  /** Item em edição; ausente = criação (CAT-02). */
  readonly item?: CatalogItemDto | undefined;
  /** 412: a lista é relida pela tela (o painel só avisa e fecha). */
  readonly onConflict: () => void;
}

/**
 * `CatalogItemFormDialog` (SCR-109 · US-104 · passos 3–5) no painel lateral do kit (`Sheet`):
 * campos fixos (código, rótulo, descrição) e campos de `metadata` dinâmicos por `catalogType`,
 * validados com os mesmos schemas Zod da API. O código só é editável na criação e fica bloqueado
 * depois (RN-TEN-59/60); a edição envia só o que mudou, com `If-Match`. Foco no primeiro campo ao
 * abrir; tela cheia abaixo de 768 px.
 */
export function CatalogFormDialog({
  open,
  onOpenChange,
  catalogType,
  item,
  onConflict,
}: CatalogFormDialogProps) {
  const t = useTranslations('catalogs');
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent closeLabel={t('form.close')}>
        {open ? (
          <CatalogFormBody
            key={`${catalogType}:${item?.id ?? 'novo'}`}
            catalogType={catalogType}
            item={item}
            onConflict={onConflict}
            onClose={() => {
              onOpenChange(false);
            }}
          />
        ) : null}
      </SheetContent>
    </Sheet>
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

  const setMetadata = (name: string, value: MetadataValue): void => {
    setValues((current) => ({ ...current, metadata: { ...current.metadata, [name]: value } }));
  };

  const optionLabel = (name: OptionsName, option: string): string =>
    allMessages.catalogs.options[name][option] ?? option;

  const metadataControl = (field: MetadataField) => {
    const name = `metadata.${field.name}`;
    const value = values.metadata[field.name];
    const label = t(`metadata.${field.name}`);
    const error = errors[name];
    switch (field.kind) {
      case 'boolean': {
        const errorId = `${fieldId(name)}-error`;
        return (
          <div key={field.name} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-3">
              <Checkbox
                id={fieldId(name)}
                checked={value === true}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                onCheckedChange={(checked) => {
                  setMetadata(field.name, checked === true);
                }}
              />
              <Label htmlFor={fieldId(name)}>{label}</Label>
            </div>
            {error ? (
              <p id={errorId} className="text-[0.8125rem] font-semibold text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        );
      }
      case 'multi': {
        const selected = Array.isArray(value) ? (value as readonly string[]) : [];
        return (
          <Field key={field.name} group label={label} error={error}>
            <div className="grid gap-2 sm:grid-cols-2">
              {field.options.map((option) => {
                const optionId = `${fieldId(name)}-${option}`;
                return (
                  <div key={option} className="flex items-center gap-3">
                    <Checkbox
                      id={optionId}
                      checked={selected.includes(option)}
                      onCheckedChange={(checked) => {
                        setMetadata(
                          field.name,
                          checked === true
                            ? [...selected, option]
                            : selected.filter((entry) => entry !== option),
                        );
                      }}
                    />
                    <Label htmlFor={optionId}>{optionLabel(field.name, option)}</Label>
                  </div>
                );
              })}
            </div>
          </Field>
        );
      }
      case 'select':
        return (
          <Field key={field.name} label={label} error={error}>
            <Select
              value={typeof value === 'string' && value !== '' ? value : NONE}
              onValueChange={(next) => {
                setMetadata(field.name, next === NONE ? '' : next);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t('form.selectPlaceholder')}</SelectItem>
                {field.options.map((option) => (
                  <SelectItem key={option} value={option}>
                    {optionLabel(field.name, option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        );
      default:
        return (
          <Field
            key={field.name}
            label={label}
            error={error}
            description={field.kind === 'color' ? t('form.color.hint') : undefined}
          >
            <Input
              type={field.kind === 'number' ? 'number' : 'text'}
              {...(field.kind === 'number' ? { min: 1, step: 1 } : {})}
              {...(field.kind === 'color' ? { placeholder: '#005BF9', maxLength: 7 } : {})}
              value={typeof value === 'string' ? value : ''}
              onChange={(event) => {
                setMetadata(field.name, event.target.value);
              }}
            />
          </Field>
        );
    }
  };

  const fields = METADATA_FIELDS[catalogType];
  const submit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void onSubmit();
  };

  return (
    <form noValidate onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      <SheetHeader>
        <SheetTitle>
          {isEdit
            ? t('form.editTitle', { name: item.label })
            : t('form.createTitle', { catalog: t(`types.${catalogType}`) })}
        </SheetTitle>
        <SheetDescription>{t('form.description')}</SheetDescription>
      </SheetHeader>

      <SheetBody>
        <div aria-live="polite" className="empty:hidden">
          {formError ? <Alert tone="error" title={formError} /> : null}
        </div>

        <Field
          label={t('form.code')}
          error={errors.code}
          description={
            isEdit
              ? item.isSystem
                ? t('form.codeLockedSystem')
                : t('form.codeLocked')
              : t('form.codeHint')
          }
        >
          <Input
            // eslint-disable-next-line jsx-a11y/no-autofocus -- foco no primeiro campo ao abrir o painel
            autoFocus={!isEdit}
            value={values.code}
            readOnly={isEdit}
            aria-readonly={isEdit ? true : undefined}
            autoComplete="off"
            onChange={(event) => {
              setValues((current) => ({ ...current, code: event.target.value }));
            }}
          />
        </Field>

        <Field label={t('form.label')} error={errors.label} description={t('form.labelHint')}>
          <Input
            // eslint-disable-next-line jsx-a11y/no-autofocus -- foco no primeiro campo editável ao abrir o painel
            autoFocus={isEdit}
            value={values.label}
            onChange={(event) => {
              setValues((current) => ({ ...current, label: event.target.value }));
            }}
          />
        </Field>

        <Field
          label={t('form.descriptionField')}
          error={errors.description}
          description={t('form.descriptionHint')}
        >
          <Textarea
            rows={3}
            value={values.description}
            onChange={(event) => {
              setValues((current) => ({ ...current, description: event.target.value }));
            }}
          />
        </Field>

        {fields.length > 0 ? (
          <fieldset className="flex flex-col gap-4">
            <legend className="mb-1 text-sm font-semibold">{t('form.metadataLegend')}</legend>
            {fields.map(metadataControl)}
          </fieldset>
        ) : null}
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
