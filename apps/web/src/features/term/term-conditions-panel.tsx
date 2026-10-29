'use client';

import {
  Alert,
  Button,
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
  Switch,
  Textarea,
} from '@contrataflow/ui';
import { AWARD_TYPES, TERM_CONDITION_LIMITS } from '@contrataflow/validation';
import type {
  AwardType,
  TermConditionField,
  TermDetailDto,
  TermPatch,
} from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { useShellSession, useTenantId } from '@/lib/session/session-context';

import { TermCollapsiblePanel } from './term-collapsible-panel';
import { conditionsBody, conditionsFormOf } from './term-conditions-model';
import type { DayCount, TermConditionsErrors, TermConditionsForm } from './term-conditions-model';
import { patchTerm, termKeys } from './term.api';
import type { TermResult } from './term.api';
import {
  WIZARD_CATALOG_STALE_TIME_MS,
  fetchActiveCatalog,
  processKeys,
} from '../processes/processes.api';

/*
 * `TermConditionsPanel` (SCR-012 · US-038 · fluxo principal 5–8 · FA-04/05/06): o painel
 * "Condições contratuais" do TR — vigência, prazo de execução/entrega com o tipo de contagem
 * (`DayCountFieldset`: um exige o outro — o salvamento fica bloqueado até a escolha), local de
 * entrega, prazo de pagamento, garantias, subcontratação, critério de julgamento (CAT-01
 * `JUDGMENT_CRITERION`; indisponível = "Tentar novamente" sem bloquear os demais campos) e tipo de
 * adjudicação. "Salvar condições" envia ao TRM-04 só os campos alterados com o `If-Match` do TR;
 * 412 oferece "Ver versão atual". Somente leitura sem permissão de edição.
 */

type Notice =
  | { readonly kind: 'ok'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'conflict' };

/** Valor da opção que limpa o campo (o Radix não aceita `SelectItem value=""`). */
const CLEAR_VALUE = '__clear__';

export interface TermConditionsPanelProps {
  readonly term: TermDetailDto;
  readonly editable: boolean;
}

export function TermConditionsPanel({ term, editable }: TermConditionsPanelProps) {
  const t = useTranslations('term.conditions');
  return (
    <TermCollapsiblePanel panel="conditions" title={t('title')}>
      <ConditionsForm term={term} editable={editable} />
    </TermCollapsiblePanel>
  );
}

function ConditionsForm({ term, editable }: TermConditionsPanelProps) {
  const t = useTranslations('term.conditions');
  const tenantId = useTenantId();
  const session = useShellSession();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<TermConditionsForm>(() => conditionsFormOf(term));
  const [errors, setErrors] = useState<TermConditionsErrors>({});
  const [notice, setNotice] = useState<Notice | null>(null);

  const patch = useMutation({
    mutationFn: (body: TermPatch) => patchTerm(term.id, body, term.version),
    onSuccess: (result) => {
      queryClient.setQueryData<TermResult>(termKeys.detail(tenantId, term.id), (previous) =>
        previous === undefined
          ? previous
          : {
              term: { ...previous.term, ...result.term },
              meta:
                result.meta === null
                  ? previous.meta
                  : { ...previous.meta, allowedActions: result.meta.allowedActions },
            },
      );
      void queryClient.invalidateQueries({ queryKey: termKeys.detail(tenantId, term.id) });
      setForm(conditionsFormOf(result.term));
      setNotice({
        kind: 'ok',
        message: t('saved', {
          time: new Intl.DateTimeFormat('pt-BR', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: session.activeTenant.timezone,
          }).format(new Date()),
        }),
      });
    },
    onError: (error: unknown) => {
      if (isApiError(error) && error.status === 422 && error.code === 'VALIDATION_ERROR') {
        const fieldErrors: TermConditionsErrors = {};
        for (const entry of error.errors) {
          fieldErrors[entry.field as TermConditionField] ??= entry.message;
        }
        setErrors(fieldErrors);
        setNotice({ kind: 'error', message: t('errors.invalid') });
        return;
      }
      setNotice(noticeOf(error));
    },
  });

  // A mensagem do painel para o erro do TRM-04 (Casos de erro da story).
  const noticeOf = (error: unknown): Notice => {
    if (!isApiError(error)) return { kind: 'error', message: t('errors.unexpected') };
    if (error.code === 'VERSION_CONFLICT') return { kind: 'conflict' };
    if (error.code === 'DOCUMENT_NOT_EDITABLE') {
      return { kind: 'error', message: t('errors.notEditable') };
    }
    if (error.code === 'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE') {
      return { kind: 'error', message: t('errors.stage') };
    }
    if (error.status === 403) return { kind: 'error', message: t('errors.permission') };
    if (error.code === 'DEPENDENCY_UNAVAILABLE' || error.status === 503) {
      return { kind: 'error', message: t('errors.unavailable') };
    }
    return {
      kind: 'error',
      message:
        error.correlationId === null
          ? t('errors.unexpected')
          : t('errors.unexpectedWithCode', { correlationId: error.correlationId }),
    };
  };

  const set = <K extends keyof TermConditionsForm>(field: K, value: TermConditionsForm[K]) => {
    setForm((current) => ({ ...current, [field]: value }));
    // O par prazo × tipo de contagem se valida em conjunto (RN-TR-29).
    const cleared = new Set<string>([field]);
    if (field === 'executionDeadline') cleared.add('executionDeadlineType');
    if (field === 'executionDeadlineType') cleared.add('executionDeadline');
    setErrors((current) =>
      Object.fromEntries(Object.entries(current).filter(([key]) => !cleared.has(key))),
    );
  };

  const check = conditionsBody(form, term);
  const dirty = check.ok ? Object.keys(check.body).length > 0 : true;
  const submit = () => {
    if (!check.ok) {
      setErrors(check.errors);
      setNotice({ kind: 'error', message: t('errors.invalid') });
      const first = Object.keys(check.errors)[0];
      if (first !== undefined) document.getElementById(`term-${first}`)?.focus();
      return;
    }
    if (Object.keys(check.body).length === 0) {
      setNotice({ kind: 'ok', message: t('nothingToSave') });
      return;
    }
    setErrors({});
    setNotice(null);
    patch.mutate(check.body);
  };

  const number = (
    field:
      'contractDurationMonths' | 'executionDeadline' | 'paymentTermDays' | 'productWarrantyMonths',
    label: string,
    hint: string | undefined,
    limits: { readonly min: number; readonly max: number },
  ) => (
    <Field id={`term-${field}`} label={label} description={hint} error={errors[field]}>
      <Input
        type="number"
        inputMode="numeric"
        min={limits.min}
        max={limits.max}
        step={1}
        value={form[field]}
        readOnly={!editable}
        onChange={(event) => {
          set(field, event.target.value);
        }}
      />
    </Field>
  );

  return (
    <>
      <p className="text-sm text-muted-foreground">{editable ? t('hint') : t('readOnly')}</p>
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        {number('contractDurationMonths', t('duration'), t('durationHint'), {
          min: TERM_CONDITION_LIMITS.contractDurationMin,
          max: TERM_CONDITION_LIMITS.contractDurationMax,
        })}
        {number('paymentTermDays', t('paymentTerm'), t('paymentTermHint'), {
          min: TERM_CONDITION_LIMITS.paymentTermMin,
          max: TERM_CONDITION_LIMITS.paymentTermMax,
        })}
        <DayCountFieldset
          form={form}
          errors={errors}
          editable={editable}
          deadlineInput={number('executionDeadline', t('deadline'), undefined, {
            min: TERM_CONDITION_LIMITS.executionDeadlineMin,
            max: TERM_CONDITION_LIMITS.executionDeadlineMax,
          })}
          onType={(value) => {
            set('executionDeadlineType', value);
          }}
        />
        <Field
          id="term-deliveryLocation"
          label={t('deliveryLocation')}
          error={errors.deliveryLocation}
          className="md:col-span-2"
        >
          <Textarea
            value={form.deliveryLocation}
            maxLength={TERM_CONDITION_LIMITS.deliveryLocationMax}
            readOnly={!editable}
            onChange={(event) => {
              set('deliveryLocation', event.target.value);
            }}
          />
        </Field>
        {number('productWarrantyMonths', t('warranty'), t('warrantyHint'), {
          min: TERM_CONDITION_LIMITS.productWarrantyMin,
          max: TERM_CONDITION_LIMITS.productWarrantyMax,
        })}
        <Field
          id="term-contractGuaranteePercent"
          label={t('guarantee')}
          description={t('guaranteeHint')}
          error={errors.contractGuaranteePercent}
        >
          <Input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={form.contractGuaranteePercent}
            readOnly={!editable}
            onChange={(event) => {
              set('contractGuaranteePercent', event.target.value);
            }}
          />
        </Field>
        <div className="flex items-center gap-3 md:col-span-2">
          <Switch
            id="term-allowsSubcontracting"
            checked={form.allowsSubcontracting}
            disabled={!editable}
            onCheckedChange={(checked) => {
              set('allowsSubcontracting', checked);
            }}
          />
          <Label htmlFor="term-allowsSubcontracting">{t('subcontracting')}</Label>
        </div>
        <JudgmentCriterionSelect
          value={form.selectionCriterionId}
          error={errors.selectionCriterionId}
          editable={editable}
          onChange={(value) => {
            set('selectionCriterionId', value);
          }}
        />
        <Field id="term-awardType" label={t('awardType')} error={errors.awardType}>
          <Select
            value={form.awardType === '' ? CLEAR_VALUE : form.awardType}
            disabled={!editable}
            onValueChange={(value) => {
              set('awardType', value === CLEAR_VALUE ? '' : (value as AwardType));
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={CLEAR_VALUE}>{t('award.NONE')}</SelectItem>
              {AWARD_TYPES.map((award) => (
                <SelectItem key={award} value={award}>
                  {t(`award.${award}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div aria-live="polite">
        {notice === null ? null : notice.kind === 'conflict' ? (
          <Alert tone="warning" title={t('errors.conflict')} live={false}>
            <div className="mt-2">
              <Button
                size="sm"
                onClick={() => {
                  void queryClient
                    .invalidateQueries({ queryKey: termKeys.detail(tenantId, term.id) })
                    .then(() => {
                      const fresh = queryClient.getQueryData<TermResult>(
                        termKeys.detail(tenantId, term.id),
                      );
                      if (fresh) setForm(conditionsFormOf(fresh.term));
                      setNotice(null);
                    });
                }}
              >
                {t('errors.reload')}
              </Button>
            </div>
          </Alert>
        ) : (
          <Alert
            tone={notice.kind === 'ok' ? 'success' : 'error'}
            title={notice.message}
            live={false}
          />
        )}
      </div>

      {editable ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={submit} disabled={patch.isPending}>
            {patch.isPending ? t('saving') : t('save')}
          </Button>
          {dirty && !patch.isPending ? (
            <span className="text-xs text-muted-foreground">{t('dirty')}</span>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** Prazo de execução/entrega e o tipo de contagem (RN-TR-29 · FA-04). */
function DayCountFieldset({
  form,
  errors,
  editable,
  deadlineInput,
  onType,
}: {
  readonly form: TermConditionsForm;
  readonly errors: TermConditionsErrors;
  readonly editable: boolean;
  readonly deadlineInput: ReactNode;
  readonly onType: (value: DayCount | '') => void;
}) {
  const t = useTranslations('term.conditions');
  const error = errors.executionDeadlineType;
  return (
    <div className="flex min-w-0 flex-col gap-4 md:col-span-2 md:grid md:grid-cols-2">
      {deadlineInput}
      <Field label={t('deadlineType')} group error={error}>
        <RadioGroup
          id="term-executionDeadlineType"
          className="flex-row flex-wrap gap-4"
          value={form.executionDeadlineType}
          disabled={!editable}
          orientation="horizontal"
          onValueChange={(value) => {
            onType(value as DayCount);
          }}
        >
          {(['CALENDAR', 'BUSINESS'] as const).map((value) => (
            <div key={value} className="flex items-center gap-2">
              <RadioGroupItem id={`term-executionDeadlineType-${value}`} value={value} />
              <Label htmlFor={`term-executionDeadlineType-${value}`} className="font-normal">
                {t(`dayCount.${value}`)}
              </Label>
            </div>
          ))}
        </RadioGroup>
      </Field>
    </div>
  );
}

/** Critério de julgamento (CAT-01 `JUDGMENT_CRITERION` · art. 33 · FA-05). */
function JudgmentCriterionSelect({
  value,
  error,
  editable,
  onChange,
}: {
  readonly value: string;
  readonly error: string | undefined;
  readonly editable: boolean;
  readonly onChange: (value: string) => void;
}) {
  const t = useTranslations('term.conditions');
  const tenantId = useTenantId();
  const options = useQuery({
    queryKey: processKeys.activeCatalog(tenantId, 'JUDGMENT_CRITERION'),
    queryFn: ({ signal }) => fetchActiveCatalog('JUDGMENT_CRITERION', signal),
    staleTime: WIZARD_CATALOG_STALE_TIME_MS,
    throwOnError: false,
  });
  if (options.isError) {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-sm font-medium" id="term-selectionCriterionId-label">
          {t('criterion')}
        </span>
        <Alert tone="error" title={t('criterionUnavailable')}>
          <div className="mt-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                void options.refetch();
              }}
            >
              {t('criterionRetry')}
            </Button>
          </div>
        </Alert>
      </div>
    );
  }
  const items = options.data ?? [];
  // O critério já gravado e desativado depois segue exibido (RN-TEN-61).
  const missing =
    value !== '' && options.data !== undefined && !items.some((item) => item.id === value);
  return (
    <Field id="term-selectionCriterionId" label={t('criterion')} error={error}>
      <Select
        value={value === '' ? CLEAR_VALUE : value}
        disabled={!editable || options.isPending}
        onValueChange={(next) => {
          onChange(next === CLEAR_VALUE ? '' : next);
        }}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={CLEAR_VALUE}>
            {options.isPending ? t('criterionLoading') : t('criterionNone')}
          </SelectItem>
          {missing ? <SelectItem value={value}>{t('criterionInactive')}</SelectItem> : null}
          {items.map((item) => (
            <SelectItem key={item.id} value={item.id}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
