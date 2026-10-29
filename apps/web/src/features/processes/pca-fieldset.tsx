'use client';

import { Input, Label, RadioGroup, RadioGroupItem, Textarea } from '@contrataflow/ui';
import { PCA_STATUSES, pcaIssues } from '@contrataflow/validation';
import type { PcaStatus } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

import { FormField } from './form-field';
import type { ProcessFormValues } from './process-form-model';

export interface PcaFieldsetProps {
  /** Prefixo dos `id` (o primeiro rádio recebe `${idPrefix}-pcaStatus`, alvo do foco de erro). */
  readonly idPrefix: string;
  readonly values: Pick<
    ProcessFormValues,
    'pcaStatus' | 'pcaYear' | 'pcaItemCode' | 'pcaJustification'
  >;
  readonly errors: Partial<
    Record<'pcaStatus' | 'pcaYear' | 'pcaItemCode' | 'pcaJustification', string | undefined>
  >;
  readonly currentYear: number;
  readonly onChange: (
    field: 'pcaStatus' | 'pcaYear' | 'pcaItemCode' | 'pcaJustification',
    value: string,
  ) => void;
}

/**
 * `PcaFieldset` (RN-PROC-12 · DEC-029): situação no PCA e os campos que dependem dela — exercício
 * e item (`PLANNED`) ou justificativa com no mínimo 20 caracteres (`NOT_PLANNED`). A mensagem da
 * justificativa aparece assim que a opção é escolhida, sem esperar o "Continuar".
 */
export function PcaFieldset({ idPrefix, values, errors, currentYear, onChange }: PcaFieldsetProps) {
  const t = useTranslations('processes');
  const statusError = errors.pcaStatus;
  const statusErrorId = `${idPrefix}-pcaStatus-error`;
  const legendId = `${idPrefix}-pcaStatus-legend`;
  const liveJustificationError =
    values.pcaStatus === 'NOT_PLANNED'
      ? (errors.pcaJustification ??
        pcaIssues({
          pcaStatus: 'NOT_PLANNED',
          pcaJustification: values.pcaJustification,
        })[0]?.message)
      : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-3 md:col-span-2">
      <fieldset
        className="flex min-w-0 flex-col gap-2"
        aria-describedby={statusError ? statusErrorId : undefined}
      >
        <legend id={legendId} className="mb-1 text-sm font-semibold">
          {t('fields.pcaStatus')}
        </legend>
        <RadioGroup
          aria-labelledby={legendId}
          aria-invalid={statusError ? true : undefined}
          aria-describedby={statusError ? statusErrorId : undefined}
          value={values.pcaStatus}
          className="flex-row flex-wrap gap-x-6 gap-y-2"
          onValueChange={(status) => {
            onChange('pcaStatus', status);
          }}
        >
          {PCA_STATUSES.map((status: PcaStatus, index) => {
            const id = index === 0 ? `${idPrefix}-pcaStatus` : `${idPrefix}-pcaStatus-${status}`;
            return (
              <div key={status} className="flex min-h-8 items-center gap-2">
                <RadioGroupItem id={id} value={status} />
                <Label htmlFor={id} className="font-normal">
                  {t(`pcaStatuses.${status}`)}
                </Label>
              </div>
            );
          })}
        </RadioGroup>
        {statusError ? (
          <p id={statusErrorId} className="text-sm text-destructive" aria-live="polite">
            {statusError}
          </p>
        ) : null}
      </fieldset>

      {values.pcaStatus === 'PLANNED' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField
            id={`${idPrefix}-pcaYear`}
            label={t('fields.pcaYear')}
            error={errors.pcaYear}
            required
          >
            {(control) => (
              <Input
                {...control}
                type="number"
                inputMode="numeric"
                min={currentYear}
                max={currentYear + 1}
                value={values.pcaYear}
                onChange={(event) => {
                  onChange('pcaYear', event.target.value);
                }}
              />
            )}
          </FormField>
          <FormField
            id={`${idPrefix}-pcaItemCode`}
            label={t('fields.pcaItemCode')}
            hint={t('fields.pcaItemCodeHint')}
            error={errors.pcaItemCode}
          >
            {(control) => (
              <Input
                {...control}
                value={values.pcaItemCode}
                onChange={(event) => {
                  onChange('pcaItemCode', event.target.value);
                }}
              />
            )}
          </FormField>
        </div>
      ) : null}

      {values.pcaStatus === 'NOT_PLANNED' ? (
        <FormField
          id={`${idPrefix}-pcaJustification`}
          label={t('fields.pcaJustification')}
          hint={t('fields.pcaJustificationHint')}
          error={liveJustificationError}
          required
        >
          {(control) => (
            <Textarea
              {...control}
              rows={4}
              value={values.pcaJustification}
              onChange={(event) => {
                onChange('pcaJustification', event.target.value);
              }}
            />
          )}
        </FormField>
      ) : null}
    </div>
  );
}
