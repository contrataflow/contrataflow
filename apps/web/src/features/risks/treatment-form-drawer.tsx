'use client';

import { Alert, Button, Dialog, DialogTitle, SheetContent, toast } from '@contrataflow/ui';
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
import { FormField, INPUT_CLASS, TEXTAREA_CLASS } from '../processes/form-field';

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
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent closeLabel={t('close')} aria-describedby={undefined}>
        <div className="border-b border-border p-4 pr-12">
          <DialogTitle>
            {props.treatment === null
              ? t('addTitle', { code: props.risk.code })
              : t('editTitle', { code: props.risk.code })}
          </DialogTitle>
        </div>
        {props.open ? <TreatmentForm key={props.treatment?.id ?? 'new'} {...props} /> : null}
      </SheetContent>
    </Dialog>
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
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
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

        <FormField
          id={fieldId('type')}
          label={t('form.fields.type')}
          hint={t('form.hints.type')}
          error={messages.type}
          required
        >
          {(control) => (
            <select
              {...control}
              className={INPUT_CLASS}
              value={values.type}
              onChange={(event) => {
                set('type', event.target.value as TreatmentType | '');
              }}
            >
              <option value="">{t('form.select')}</option>
              {TREATMENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {TREATMENT_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField
          id={fieldId('description')}
          label={t('form.fields.description')}
          error={messages.description}
          required
        >
          {(control) => (
            <textarea
              {...control}
              className={TEXTAREA_CLASS}
              maxLength={TREATMENT_LIMITS.descriptionMax}
              value={values.description}
              onChange={(event) => {
                set('description', event.target.value);
              }}
            />
          )}
        </FormField>
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
        <FormField
          id={fieldId('dueDate')}
          label={t('form.fields.dueDate')}
          hint={t('form.hints.dueDate')}
          error={messages.dueDate}
        >
          {(control) => (
            <input
              {...control}
              type="date"
              className={INPUT_CLASS}
              value={values.dueDate}
              onChange={(event) => {
                set('dueDate', event.target.value);
              }}
            />
          )}
        </FormField>
        <FormField id={fieldId('notes')} label={t('form.fields.notes')} error={messages.notes}>
          {(control) => (
            <textarea
              {...control}
              className={TEXTAREA_CLASS}
              maxLength={TREATMENT_LIMITS.notesMax}
              value={values.notes}
              onChange={(event) => {
                set('notes', event.target.value);
              }}
            />
          )}
        </FormField>
      </div>
      <div className="flex flex-col-reverse gap-2 border-t border-border p-4 sm:flex-row sm:justify-end">
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
      </div>
    </form>
  );
}
