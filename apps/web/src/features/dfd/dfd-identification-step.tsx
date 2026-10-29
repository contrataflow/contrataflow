'use client';

import {
  DatePicker,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  cx,
  fromIsoDate,
  toIsoDate,
} from '@contrataflow/ui';
import { PRIORITIES } from '@contrataflow/validation';
import type { DfdHeaderField, DfdHeaderValues, Priority } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

import { raisesProcessPriority } from './dfd-model';
import { FormField } from '../processes/form-field';
import { OwnerLookup } from '../risks/owner-lookup';

export interface DfdIdentificationStepProps {
  readonly code: string | null;
  readonly header: DfdHeaderValues;
  readonly errors: Partial<Record<DfdHeaderField, string>>;
  readonly editable: boolean;
  readonly processPriority: Priority;
  readonly secretariatName: string;
  /** Unidades ativas da secretaria solicitante (RN-DFD-09). */
  readonly departments: readonly { readonly id: string; readonly name: string }[];
  readonly responsibleName: string;
  readonly today: string;
  readonly onChange: (field: DfdHeaderField, value: string | null) => void;
  readonly onResponsibleChange: (id: string, name: string) => void;
}

/**
 * `DfdIdentificationStep` (SCR-007 · passo 1 · Decreto 10.947/2022, art. 8º, II/VI/VIII): número
 * somente leitura, data, setor da secretaria solicitante, responsável pela demanda (USR-02),
 * objeto e prioridade com a descrição de cada grau; prioridade acima da do processo mostra a dica
 * de US-017. Os `id` dos controles são o alvo do "Ir para o campo" da revisão.
 */
export function DfdIdentificationStep({
  code,
  header,
  errors,
  editable,
  processPriority,
  secretariatName,
  departments,
  responsibleName,
  today,
  onChange,
  onResponsibleChange,
}: DfdIdentificationStepProps) {
  const t = useTranslations('dfd.identification');
  const raised = raisesProcessPriority(header.priority, processPriority);
  return (
    <div className="grid min-w-0 grid-cols-1 gap-5 rounded-card bg-surface p-6 shadow-card md:grid-cols-2">
      <FormField id="dfd-field-code" label={t('number')}>
        {(control) => <Input {...control} value={code ?? ''} readOnly aria-readonly />}
      </FormField>
      <FormField
        id="dfd-field-requestDate"
        label={t('requestDate')}
        error={errors.requestDate}
        required
      >
        {(control) => (
          <DatePicker
            {...control}
            value={fromIsoDate(header.requestDate ?? '')}
            disabled={!editable}
            disabledDays={{ after: fromIsoDate(today) ?? new Date() }}
            onValueChange={(date) => {
              onChange('requestDate', date ? toIsoDate(date) : null);
            }}
            labels={{
              placeholder: t('datePlaceholder'),
              calendar: t('dateCalendar'),
            }}
          />
        )}
      </FormField>
      <FormField
        id="dfd-field-requestingDepartmentId"
        label={t('department')}
        hint={t('departmentHint', { secretariat: secretariatName })}
        error={errors.requestingDepartmentId}
        required
      >
        {(control) => (
          <Select
            value={header.requestingDepartmentId ?? ''}
            disabled={!editable}
            onValueChange={(value) => {
              onChange('requestingDepartmentId', value || null);
            }}
          >
            <SelectTrigger {...control}>
              <SelectValue placeholder={t('departmentPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {departments.map((department) => (
                <SelectItem key={department.id} value={department.id}>
                  {department.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </FormField>
      <div className="flex min-w-0 flex-col gap-1">
        <OwnerLookup
          id="dfd-field-responsibleId"
          kind="USER"
          label={t('responsible')}
          hint={t('responsibleHint')}
          value={header.responsibleId ?? ''}
          name={responsibleName}
          error={errors.responsibleId}
          disabled={!editable}
          onChange={onResponsibleChange}
        />
      </div>
      <FormField
        id="dfd-field-objectSummary"
        label={t('object')}
        hint={t('objectHint')}
        error={errors.objectSummary}
        required
        className="md:col-span-2"
      >
        {(control) => (
          <Textarea
            {...control}
            maxLength={2000}
            value={header.objectSummary ?? ''}
            readOnly={!editable}
            onChange={(event) => {
              onChange('objectSummary', event.target.value);
            }}
          />
        )}
      </FormField>
      <fieldset
        className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0 md:col-span-2"
        aria-describedby={errors.priority ? 'dfd-field-priority-error' : undefined}
      >
        <legend className="mb-1.5 p-0 text-sm font-semibold">{t('priority')}</legend>
        <RadioGroup
          value={header.priority ?? ''}
          disabled={!editable}
          aria-invalid={errors.priority ? true : undefined}
          className="grid grid-cols-1 gap-2 md:grid-cols-2"
          onValueChange={(value) => {
            onChange('priority', value);
          }}
        >
          {PRIORITIES.map((priority, index) => {
            const inputId = index === 0 ? 'dfd-field-priority' : `dfd-field-priority-${priority}`;
            const checked = header.priority === priority;
            return (
              <div
                key={priority}
                className={cx(
                  'flex items-start gap-2.5 rounded-control border p-3 text-sm',
                  checked ? 'border-primary bg-primary-soft' : 'border-border',
                )}
              >
                <RadioGroupItem
                  id={inputId}
                  value={priority}
                  className="mt-0.5"
                  aria-describedby={`${inputId}-description`}
                />
                <div className="flex flex-col">
                  <Label htmlFor={inputId}>{t(`priorities.${priority}`)}</Label>
                  <span id={`${inputId}-description`} className="text-muted-foreground">
                    {t(`priorityDescriptions.${priority}`)}
                  </span>
                </div>
              </div>
            );
          })}
        </RadioGroup>
        {errors.priority ? (
          <p
            id="dfd-field-priority-error"
            className="text-[0.8125rem] font-semibold text-destructive"
            aria-live="polite"
          >
            {errors.priority}
          </p>
        ) : null}
        {raised && header.priority !== null ? (
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {t('priorityRaise', { priority: t(`priorities.${header.priority}`) })}
          </p>
        ) : null}
      </fieldset>
    </div>
  );
}
