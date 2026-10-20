'use client';

import { PRIORITIES } from '@contrataflow/validation';
import type { DfdHeaderField, DfdHeaderValues, Priority } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

import { raisesProcessPriority } from './dfd-model';
import { FormField, INPUT_CLASS, TEXTAREA_CLASS } from '../processes/form-field';
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
    <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
      <FormField id="dfd-field-code" label={t('number')}>
        {(control) => (
          <input {...control} className={INPUT_CLASS} value={code ?? ''} readOnly aria-readonly />
        )}
      </FormField>
      <FormField
        id="dfd-field-requestDate"
        label={t('requestDate')}
        error={errors.requestDate}
        required
      >
        {(control) => (
          <input
            {...control}
            type="date"
            className={INPUT_CLASS}
            max={today}
            value={header.requestDate ?? ''}
            readOnly={!editable}
            onChange={(event) => {
              onChange('requestDate', event.target.value || null);
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
          <select
            {...control}
            className={INPUT_CLASS}
            value={header.requestingDepartmentId ?? ''}
            disabled={!editable}
            onChange={(event) => {
              onChange('requestingDepartmentId', event.target.value || null);
            }}
          >
            <option value="">{t('departmentPlaceholder')}</option>
            {departments.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-sm font-medium">{t('responsible')}</span>
        <OwnerLookup
          id="dfd-field-responsibleId"
          kind="USER"
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
          <textarea
            {...control}
            className={TEXTAREA_CLASS}
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
        className="flex min-w-0 flex-col gap-2 md:col-span-2"
        aria-describedby={errors.priority ? 'dfd-field-priority-error' : undefined}
      >
        <legend className="text-sm font-medium">{t('priority')}</legend>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {PRIORITIES.map((priority, index) => {
            const inputId = index === 0 ? 'dfd-field-priority' : `dfd-field-priority-${priority}`;
            return (
              <div
                key={priority}
                className="flex items-start gap-2 rounded-control border border-border p-3 text-sm"
              >
                <input
                  id={inputId}
                  type="radio"
                  name="dfd-priority"
                  value={priority}
                  className="mt-1 size-4"
                  checked={header.priority === priority}
                  disabled={!editable}
                  aria-describedby={`${inputId}-description`}
                  onChange={() => {
                    onChange('priority', priority);
                  }}
                />
                <div className="flex flex-col">
                  <label htmlFor={inputId} className="font-medium">
                    {t(`priorities.${priority}`)}
                  </label>
                  <span id={`${inputId}-description`} className="text-muted-foreground">
                    {t(`priorityDescriptions.${priority}`)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
        {errors.priority ? (
          <p id="dfd-field-priority-error" className="text-sm text-destructive" aria-live="polite">
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
