'use client';

import type { HolidayScope } from '@contrataflow/types';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  toast,
} from '@contrataflow/ui';
import type { HolidayDto } from '@contrataflow/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { useTenantId } from '@/lib/session/session-context';

import {
  buildCreateBody,
  buildPatch,
  initialValues,
  scopeOptions,
  validateForm,
} from './calendar-model';
import type { FieldErrors, FormValues } from './calendar-model';
import { calendarKeys, createHoliday, updateHoliday } from './calendar.api';

const INPUT = 'h-10 rounded-control border border-border bg-surface px-3 text-sm';

export interface HolidayFormDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Feriado em edição; ausente = criação (CAL-02). */
  readonly holiday?: HolidayDto | undefined;
  /** 412: a lista é relida pela tela (o diálogo só avisa e fecha). */
  readonly onConflict: () => void;
}

/**
 * `HolidayFormDialog` (SCR-110 · US-106 · passos 2–4): data, nome, escopo e recorrência, validados
 * com os mesmos schemas Zod da API. A data só é editável no cadastro (RN-TEN-75: excluir e
 * recadastrar para mudá-la); o nome de feriado de sistema fica bloqueado (RN-TEN-77). A edição
 * envia só o que mudou, com `If-Match`. Foco no primeiro campo ao abrir; erros em `aria-live`;
 * tela cheia abaixo de 768 px.
 */
export function HolidayFormDialog({
  open,
  onOpenChange,
  holiday,
  onConflict,
}: HolidayFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="h-dvh max-h-dvh overflow-y-auto md:h-auto md:max-h-[90vh]"
        style={{ maxWidth: '32rem' }}
      >
        <HolidayFormBody
          key={holiday?.id ?? 'novo'}
          holiday={holiday}
          onConflict={onConflict}
          onClose={() => {
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function HolidayFormBody({
  holiday,
  onConflict,
  onClose,
}: {
  readonly holiday: HolidayDto | undefined;
  readonly onConflict: () => void;
  readonly onClose: () => void;
}) {
  const t = useTranslations('calendar');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const ids = useId();
  const [values, setValues] = useState<FormValues>(() => initialValues(holiday));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const isEdit = holiday !== undefined;

  const create = useMutation({ mutationFn: createHoliday });
  const update = useMutation({
    mutationFn: ({
      id,
      patch,
      version,
    }: {
      id: string;
      patch: ReturnType<typeof buildPatch>;
      version: number;
    }) => updateHoliday(id, patch, version),
  });
  const pending = create.isPending || update.isPending;

  const messages = {
    required: (field: 'date' | 'name' | 'scope') =>
      t('validation.required', { field: t(`validation.field.${field}`) }),
    invalidDate: t('validation.invalidDate'),
    tooLong: (max: number) => t('validation.tooLong', { max }),
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
    if (error.status === 409) {
      setFormError(
        error.code === 'CATALOG_ITEM_SYSTEM' ? t('errors.system') : t('errors.duplicate'),
      );
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

  const finish = (saved: HolidayDto, key: 'created' | 'updated'): void => {
    toast({ title: t(`toast.${key}`, { name: saved.name }), tone: 'success' });
    void queryClient.invalidateQueries({ queryKey: calendarKeys.all(tenantId) });
    onClose();
  };

  const onSubmit = async (): Promise<void> => {
    setFormError(null);
    const problems = validateForm(values, isEdit ? 'edit' : 'create', messages);
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    try {
      if (holiday) {
        const patch = buildPatch(values, holiday);
        if (Object.keys(patch).length === 0) {
          onClose();
          return;
        }
        const result = await update.mutateAsync({
          id: holiday.id,
          patch,
          version: holiday.version,
        });
        finish(result.data, 'updated');
      } else {
        const result = await create.mutateAsync(buildCreateBody(values));
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
  const describedBy = (name: string, hint?: boolean) =>
    [
      errors[name] ? `${fieldId(name)}-error` : undefined,
      hint ? `${fieldId(name)}-hint` : undefined,
    ]
      .filter(Boolean)
      .join(' ') || undefined;

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
        {isEdit ? t('form.editTitle', { name: holiday.name }) : t('form.createTitle')}
      </DialogTitle>
      <DialogDescription>{t('form.description')}</DialogDescription>

      {formError ? <Alert tone="error" title={formError} /> : null}

      <div className="flex flex-col gap-1">
        <label htmlFor={fieldId('date')} className="text-sm font-medium">
          {t('form.date')}
        </label>
        <input
          id={fieldId('date')}
          type="date"
          className={INPUT}
          value={values.date}
          readOnly={isEdit}
          aria-readonly={isEdit ? true : undefined}
          aria-invalid={errors.date ? true : undefined}
          aria-describedby={describedBy('date', true)}
          onChange={(event) => {
            setValues((current) => ({ ...current, date: event.target.value }));
          }}
        />
        <p id={`${fieldId('date')}-hint`} className="text-xs text-muted-foreground">
          {t('form.dateHint')}
        </p>
        {errorText('date')}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={fieldId('name')} className="text-sm font-medium">
          {t('form.name')}
        </label>
        <input
          id={fieldId('name')}
          className={INPUT}
          value={values.name}
          readOnly={holiday?.isSystem === true}
          aria-readonly={holiday?.isSystem ? true : undefined}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={describedBy('name', true)}
          autoComplete="off"
          onChange={(event) => {
            setValues((current) => ({ ...current, name: event.target.value }));
          }}
        />
        <p id={`${fieldId('name')}-hint`} className="text-xs text-muted-foreground">
          {holiday?.isSystem ? t('form.nameLockedSystem') : t('form.nameHint')}
        </p>
        {errorText('name')}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={fieldId('scope')} className="text-sm font-medium">
          {t('form.scope')}
        </label>
        <select
          id={fieldId('scope')}
          className={INPUT}
          value={values.scope}
          aria-invalid={errors.scope ? true : undefined}
          aria-describedby={describedBy('scope', true)}
          onChange={(event) => {
            setValues((current) => ({
              ...current,
              scope: event.target.value as HolidayScope | '',
            }));
          }}
        >
          <option value="">{t('form.scopePlaceholder')}</option>
          {scopeOptions(holiday).map((scope) => (
            <option key={scope} value={scope}>
              {t(`scopes.${scope}`)}
            </option>
          ))}
        </select>
        <p id={`${fieldId('scope')}-hint`} className="text-xs text-muted-foreground">
          {t('form.scopeHint')}
        </p>
        {errorText('scope')}
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <input
            id={fieldId('recurring')}
            type="checkbox"
            className="size-4"
            checked={values.isRecurring}
            aria-describedby={`${fieldId('recurring')}-hint`}
            onChange={(event) => {
              setValues((current) => ({ ...current, isRecurring: event.target.checked }));
            }}
          />
          <label htmlFor={fieldId('recurring')} className="text-sm font-medium">
            {t('form.recurring')}
          </label>
        </div>
        <p id={`${fieldId('recurring')}-hint`} className="text-xs text-muted-foreground">
          {t('form.recurringHint')}
        </p>
      </div>

      {isEdit ? (
        <div className="flex items-center gap-2">
          <input
            id={fieldId('active')}
            type="checkbox"
            className="size-4"
            checked={values.isActive}
            onChange={(event) => {
              setValues((current) => ({ ...current, isActive: event.target.checked }));
            }}
          />
          <label htmlFor={fieldId('active')} className="text-sm font-medium">
            {t('form.active')}
          </label>
        </div>
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
