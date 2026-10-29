'use client';

import {
  Alert,
  Button,
  DatePicker,
  Field,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  Textarea,
  fromIsoDate,
  toIsoDate,
  toast,
} from '@contrataflow/ui';
import {
  TREATMENT_LIMITS,
  TREATMENT_MESSAGES,
  TREATMENT_TYPES,
  TREATMENT_TYPE_LABELS,
} from '@contrataflow/validation';
import type { RiskDto, RiskTreatmentDto, TreatmentType } from '@contrataflow/validation';
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';

import { CorrelationCode } from '@/components/errors/correlation-code';
import { newIdempotencyKey } from '@/lib/api/client';

import { OwnerLookup } from './owner-lookup';
import { createTreatment, updateTreatment } from './risks.api';
import {
  createTreatmentBodyOf,
  treatmentFormValuesOf,
  treatmentPatchOf,
  treatmentProblemOf,
  validateTreatment,
} from './treatments-model';
import type {
  TreatmentFieldMessages,
  TreatmentFormValues,
  TreatmentProblem,
} from './treatments-model';

export interface TreatmentFormDrawerProps {
  readonly risk: RiskDto;
  /** `null` = nova ação; a ação em edição vem sempre da lista mais recente (versão atual). */
  readonly treatment: RiskTreatmentDto | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Recarrega a lista (sucesso, 412 e recusas por estado). */
  readonly onChanged: () => Promise<void> | void;
}

/**
 * `TreatmentFormDrawer` (US-034 · SCR-011): painel lateral de cadastro e edição da ação de
 * tratamento — tipo, descrição, responsável (pessoa — USR-02 — e/ou unidade — DEP-02), prazo
 * (pode ser passado — FA-03) e observações. Validado com o MESMO schema da API; criação com
 * `Idempotency-Key` estável entre reenvios; edição só com os campos alterados e `If-Match`. O status
 * muda pelo `TreatmentStatusSelect` da lista.
 */
export function TreatmentFormDrawer(props: TreatmentFormDrawerProps) {
  const t = useTranslations('risks.treatments.form');
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent closeLabel={t('close')} aria-describedby={undefined}>
        <SheetHeader>
          <SheetTitle>
            {props.treatment === null
              ? t('addTitle', { code: props.risk.code })
              : t('editTitle', { code: props.risk.code })}
          </SheetTitle>
        </SheetHeader>
        {props.open ? <TreatmentForm key={props.treatment?.id ?? 'new'} {...props} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function TreatmentForm({ risk, treatment, onOpenChange, onChanged }: TreatmentFormDrawerProps) {
  const t = useTranslations('risks.treatments');
  const tErrors = useTranslations('errors.correlation');
  const idPrefix = useId();
  const formRef = useRef<HTMLFormElement | null>(null);
  const [values, setValues] = useState<TreatmentFormValues>(() => treatmentFormValuesOf(treatment));
  const [messages, setMessages] = useState<TreatmentFieldMessages>({});
  const [problem, setProblem] = useState<TreatmentProblem | null>(null);
  const idempotencyKey = useRef(newIdempotencyKey());

  const set = <K extends keyof TreatmentFormValues>(field: K, value: TreatmentFormValues[K]) => {
    setValues((current) => ({ ...current, [field]: value }));
  };
  const fieldId = (name: string) => `${idPrefix}-${name}`;
  const focusFirstError = () => {
    setTimeout(() => {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    }, 0);
  };

  const save = useMutation({
    mutationFn: async (patch: ReturnType<typeof treatmentPatchOf> | null) =>
      treatment === null
        ? createTreatment(risk.id, createTreatmentBodyOf(values), idempotencyKey.current)
        : updateTreatment(treatment.id, patch ?? {}, treatment.version),
    onSuccess: async () => {
      toast({
        title: treatment === null ? t('toast.added', { code: risk.code }) : t('toast.updated'),
        tone: 'success',
      });
      idempotencyKey.current = newIdempotencyKey();
      await onChanged();
      onOpenChange(false);
    },
    onError: (error: unknown) => {
      const found = treatmentProblemOf(error);
      if (found.kind === 'fields') {
        setMessages(found.fields);
        setProblem(found);
        focusFirstError();
        return;
      }
      if (found.kind === 'keyReused') idempotencyKey.current = newIdempotencyKey();
      if (found.kind === 'notFound') {
        toast({ title: t('form.errors.notFound'), tone: 'error' });
        void onChanged();
        onOpenChange(false);
        return;
      }
      if (found.kind === 'stale' || found.kind === 'permission' || found.kind === 'blocked') {
        void onChanged();
      }
      setProblem(found);
    },
  });

  const submit = () => {
    const found = validateTreatment(values);
    setMessages(found);
    if (Object.keys(found).length > 0) {
      setProblem({ kind: 'fields', fields: found });
      focusFirstError();
      return;
    }
    setProblem(null);
    if (treatment === null) {
      save.mutate(null);
      return;
    }
    const patch = treatmentPatchOf(treatment, values);
    if (Object.keys(patch).length === 0) {
      onOpenChange(false);
      return;
    }
    save.mutate(patch);
  };

  const pending = save.isPending;
  return (
    <form
      ref={formRef}
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <SheetBody>
        <div aria-live="polite" className="flex flex-col gap-2">
          {problem?.kind === 'fields' ? (
            <Alert tone="error" title={t('form.errors.formErrors')} />
          ) : null}
          {problem?.kind === 'stale' ? (
            <Alert tone="warning" title={TREATMENT_MESSAGES.versionConflict}>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="mt-2"
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                {t('form.errors.reload')}
              </Button>
            </Alert>
          ) : null}
          {problem?.kind === 'keyReused' ? (
            <Alert tone="warning" title={t('form.errors.keyReused')} />
          ) : null}
          {problem?.kind === 'permission' ? (
            <Alert tone="error" title={TREATMENT_MESSAGES.permissionDenied} />
          ) : null}
          {problem?.kind === 'blocked' || problem?.kind === 'invalidState' ? (
            <Alert tone="error" title={problem.message} />
          ) : null}
          {problem?.kind === 'unavailable' ? (
            <Alert tone="error" title={TREATMENT_MESSAGES.unavailable}>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="mt-2"
                disabled={pending}
                onClick={submit}
              >
                {t('form.errors.retry')}
              </Button>
            </Alert>
          ) : null}
          {problem?.kind === 'unexpected' ? (
            <Alert tone="error" title={t('form.errors.unexpected')}>
              <CorrelationCode
                correlationId={problem.correlationId}
                labels={{
                  code: tErrors('label', { correlationId: problem.correlationId }),
                  copy: tErrors('copy'),
                  copied: tErrors('copied'),
                }}
              />
            </Alert>
          ) : null}
        </div>

        <Field
          id={fieldId('type')}
          label={t('form.fields.type')}
          description={t('form.hints.type')}
          error={messages.type}
          required
        >
          <Select
            value={values.type}
            onValueChange={(value) => {
              set('type', value as TreatmentType);
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder={t('form.select')} />
            </SelectTrigger>
            <SelectContent>
              {TREATMENT_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {TREATMENT_TYPE_LABELS[type]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field
          id={fieldId('description')}
          label={t('form.fields.description')}
          error={messages.description}
          required
        >
          <Textarea
            maxLength={TREATMENT_LIMITS.descriptionMax}
            value={values.description}
            onChange={(event) => {
              set('description', event.target.value);
            }}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <OwnerLookup
            id={fieldId('responsibleId')}
            kind="USER"
            value={values.responsibleId}
            name={values.responsibleName}
            onChange={(id, name) => {
              setValues((current) => ({ ...current, responsibleId: id, responsibleName: name }));
            }}
            error={messages.responsibleId}
            disabled={pending}
          />
          <OwnerLookup
            id={fieldId('responsibleDepartmentId')}
            kind="DEPARTMENT"
            value={values.responsibleDepartmentId}
            name={values.responsibleDepartmentName}
            onChange={(id, name) => {
              setValues((current) => ({
                ...current,
                responsibleDepartmentId: id,
                responsibleDepartmentName: name,
              }));
            }}
            error={messages.responsibleDepartmentId}
            disabled={pending}
          />
        </div>
        <Field
          id={fieldId('dueDate')}
          label={t('form.fields.dueDate')}
          description={t('form.hints.dueDate')}
          error={messages.dueDate}
        >
          <DatePicker
            clearable
            value={fromIsoDate(values.dueDate)}
            onValueChange={(date) => {
              set('dueDate', date ? toIsoDate(date) : '');
            }}
            labels={{
              placeholder: t('form.datePlaceholder'),
              calendar: t('form.dateCalendar'),
              clear: t('form.dateClear'),
            }}
          />
        </Field>
        <Field id={fieldId('notes')} label={t('form.fields.notes')} error={messages.notes}>
          <Textarea
            maxLength={TREATMENT_LIMITS.notesMax}
            value={values.notes}
            onChange={(event) => {
              set('notes', event.target.value);
            }}
          />
        </Field>
      </SheetBody>
      <SheetFooter>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            onOpenChange(false);
          }}
        >
          {t('form.cancel')}
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? t('form.saving') : t('form.save')}
        </Button>
      </SheetFooter>
    </form>
  );
}
