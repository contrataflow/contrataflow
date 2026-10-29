'use client';

import type { HolidayScope } from '@contrataflow/types';
import {
  Alert,
  Button,
  Checkbox,
  DatePicker,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Field,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  fromIsoDate,
  toIsoDate,
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
 * envia só o que mudou, com `If-Match`. Controles do kit (`DatePicker`, `Select`, `Checkbox`) dentro
 * de `Field`, que liga rótulo, ajuda e erro; foco preso e `Esc` fecha (Radix Dialog).
 */
export function HolidayFormDialog({
  open,
  onOpenChange,
  holiday,
  onConflict,
}: HolidayFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
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

      <div aria-live="polite" className="empty:hidden">
        {formError ? <Alert tone="error" title={formError} /> : null}
      </div>

      <Field label={t('form.date')} description={t('form.dateHint')} error={errors.date}>
        <DatePicker
          value={fromIsoDate(values.date)}
          disabled={isEdit}
          labels={{
            placeholder: t('form.datePlaceholder'),
            clear: t('form.dateClear'),
            calendar: t('form.dateCalendar'),
          }}
          onValueChange={(date) => {
            setValues((current) => ({ ...current, date: date ? toIsoDate(date) : '' }));
          }}
        />
      </Field>

      <Field
        label={t('form.name')}
        description={holiday?.isSystem ? t('form.nameLockedSystem') : t('form.nameHint')}
        error={errors.name}
      >
        <Input
          value={values.name}
          readOnly={holiday?.isSystem === true}
          autoComplete="off"
          onChange={(event) => {
            setValues((current) => ({ ...current, name: event.target.value }));
          }}
        />
      </Field>

      <Field label={t('form.scope')} description={t('form.scopeHint')} error={errors.scope}>
        <Select
          value={values.scope}
          onValueChange={(scope) => {
            setValues((current) => ({ ...current, scope: scope as HolidayScope }));
          }}
        >
          <SelectTrigger>
            <SelectValue placeholder={t('form.scopePlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            {scopeOptions(holiday).map((scope) => (
              <SelectItem key={scope} value={scope}>
                {t(`scopes.${scope}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2.5">
          <Checkbox
            id={`${ids}-recurring`}
            checked={values.isRecurring}
            aria-describedby={`${ids}-recurring-hint`}
            onCheckedChange={(checked) => {
              setValues((current) => ({ ...current, isRecurring: checked === true }));
            }}
          />
          <Label htmlFor={`${ids}-recurring`}>{t('form.recurring')}</Label>
        </div>
        <p id={`${ids}-recurring-hint`} className="text-[0.8125rem] text-muted-foreground">
          {t('form.recurringHint')}
        </p>
      </div>

      {isEdit ? (
        <div className="flex items-center gap-2.5">
          <Checkbox
            id={`${ids}-active`}
            checked={values.isActive}
            onCheckedChange={(checked) => {
              setValues((current) => ({ ...current, isActive: checked === true }));
            }}
          />
          <Label htmlFor={`${ids}-active`}>{t('form.active')}</Label>
        </div>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onClose}>
          {t('form.cancel')}
        </Button>
        <Button type="submit" aria-busy={pending} disabled={pending}>
          {pending ? t('form.submitting') : t('form.submit')}
        </Button>
      </DialogFooter>
    </form>
  );
}
