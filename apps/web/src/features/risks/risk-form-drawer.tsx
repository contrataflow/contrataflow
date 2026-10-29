'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SheetContent,
  toast,
} from '@contrataflow/ui';
import {
  RISK_LEVEL_LABELS,
  RISK_LIMITS,
  RISK_MESSAGES,
  RISK_PHASES,
  RISK_PHASE_LABELS,
  RISK_STATUSES,
  RISK_STATUS_LABELS,
} from '@contrataflow/validation';
import type {
  CatalogItemDto,
  RiskDto,
  RiskListMetaDto,
  RiskPhase,
  RiskStatus,
} from '@contrataflow/validation';
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';

import { CorrelationCode } from '@/components/errors/correlation-code';
import { newIdempotencyKey } from '@/lib/api/client';

import { LevelBadge } from './level-badge';
import { OwnerLookup } from './owner-lookup';
import { ProbabilityImpactGrid } from './probability-impact-grid';
import {
  createBodyOf,
  divergentFieldsOf,
  levelTransitionOf,
  liveAssessment,
  patchOf,
  referenceFieldsOf,
  riskFormValuesOf,
  riskProblemOf,
  validateRisk,
} from './risks-model';
import type { RiskFieldMessages, RiskFormField, RiskFormValues, RiskProblem } from './risks-model';
import { createRisk, updateRisk, useRiskCategories } from './risks.api';
import { FormField, INPUT_CLASS, SelectField, TEXTAREA_CLASS } from '../processes/form-field';
import type { SelectOption } from '../processes/form-field';

export interface RiskFormDrawerProps {
  readonly processId: string;
  /** `null` = novo risco; o risco em edição vem sempre da lista mais recente (versão atual). */
  readonly risk: RiskDto | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Escala e faixas vigentes (`meta` de RSK-01). */
  readonly meta: RiskListMetaDto;
  /** Recarrega a lista (sucesso, 412 e recusas por estado). */
  readonly onChanged: () => Promise<void> | void;
}

/** Categorias ativas + a atual do risco (mesmo inativa: segue exibida — RN-TEN-61). */
function categoryOptions(
  categories: readonly CatalogItemDto[] | undefined,
  risk: RiskDto | null,
): SelectOption[] {
  const options = (categories ?? []).map((item) => ({ value: item.id, label: item.label }));
  if (risk !== null && !options.some((option) => option.value === risk.category.id)) {
    options.unshift({ value: risk.category.id, label: risk.category.label });
  }
  return options;
}

/**
 * `RiskFormDrawer` (US-033 · SCR-011): painel lateral de registro e reavaliação. Validado com o
 * MESMO schema da API; escore e nível em tempo real (`assessRisk`) e, na reavaliação, a transição
 * de nível (FA-01). Criação com `Idempotency-Key` estável entre reenvios; edição só com os campos
 * alterados e `If-Match` da versão atual. 412 recarrega o risco e destaca o que mudou; 503 mantém
 * os dados com "Tentar novamente"; 422 marca os campos e foca o primeiro com erro.
 */
export function RiskFormDrawer(props: RiskFormDrawerProps) {
  const t = useTranslations('risks.form');
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent closeLabel={t('close')} aria-describedby={undefined}>
        <div className="border-b border-border p-4 pr-12">
          <DialogTitle>
            {props.risk === null ? t('addTitle') : t('editTitle', { code: props.risk.code })}
          </DialogTitle>
        </div>
        {props.open ? <RiskForm key={props.risk?.id ?? 'new'} {...props} /> : null}
      </SheetContent>
    </Dialog>
  );
}

function RiskForm({ processId, risk, onOpenChange, meta, onChanged }: RiskFormDrawerProps) {
  const t = useTranslations('risks');
  const tErrors = useTranslations('errors.correlation');
  const idPrefix = useId();
  const formRef = useRef<HTMLFormElement | null>(null);
  const categories = useRiskCategories();
  const [values, setValues] = useState<RiskFormValues>(() => riskFormValuesOf(risk));
  const [base, setBase] = useState<RiskDto | null>(risk);
  const [messages, setMessages] = useState<RiskFieldMessages>({});
  const [problem, setProblem] = useState<RiskProblem | null>(null);
  const [conflict, setConflict] = useState(false);
  const idempotencyKey = useRef(newIdempotencyKey());
  const { scale, levelThresholds } = meta;

  const set = <K extends keyof RiskFormValues>(field: K, value: RiskFormValues[K]) => {
    setValues((current) => ({ ...current, [field]: value }));
  };
  const fieldId = (name: string) => `${idPrefix}-${name}`;
  const focusFirstError = () => {
    setTimeout(() => {
      const invalid = formRef.current?.querySelector<HTMLElement>(
        '[aria-invalid="true"], [data-invalid="true"]',
      );
      if (!invalid) return;
      const target =
        invalid.getAttribute('role') === 'grid'
          ? (invalid.querySelector<HTMLElement>('[tabindex="0"]') ?? invalid)
          : invalid;
      target.focus();
    }, 0);
  };

  const save = useMutation({
    mutationFn: async (patch: ReturnType<typeof patchOf> | null) => {
      if (risk === null) return createRisk(processId, createBodyOf(values), idempotencyKey.current);
      return updateRisk(risk.id, patch ?? {}, risk.version);
    },
    onSuccess: async (saved) => {
      if (risk === null) {
        toast({ title: t('toast.added', { code: saved.code }), tone: 'success' });
      } else {
        const transition = levelTransitionOf(risk.level, saved.level);
        const reassessed = saved.probability !== risk.probability || saved.impact !== risk.impact;
        toast({
          title:
            reassessed && transition !== null
              ? t('toast.reassessed', { code: saved.code, transition })
              : t('toast.updated', { code: saved.code }),
          tone: 'success',
        });
      }
      idempotencyKey.current = newIdempotencyKey();
      await onChanged();
      onOpenChange(false);
    },
    onError: (error: unknown) => {
      const found = riskProblemOf(error, scale.max);
      if (found.kind === 'stale') {
        // Recarrega o risco e mantém o formulário (a próxima gravação usa a versão nova).
        setConflict(true);
        setProblem(found);
        void onChanged();
        return;
      }
      if (found.kind === 'fields') {
        setMessages(found.fields);
        setProblem(found);
        if (referenceFieldsOf(found.fields).length > 0) void categories.refetch();
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
      if (found.kind === 'permission' || found.kind === 'blocked') void onChanged();
      setProblem(found);
    },
  });

  const submit = () => {
    const found = validateRisk(values, scale.max);
    setMessages(found);
    if (Object.keys(found).length > 0) {
      setProblem({ kind: 'fields', fields: found });
      focusFirstError();
      return;
    }
    setProblem(null);
    if (risk === null) {
      save.mutate(null);
      return;
    }
    const patch = patchOf(risk, values);
    if (Object.keys(patch).length === 0) {
      onOpenChange(false);
      return;
    }
    save.mutate(patch);
  };

  const inherent = liveAssessment(values.probability, values.impact, scale.max, levelThresholds);
  const residual = liveAssessment(
    values.residualProbability,
    values.residualImpact,
    scale.max,
    levelThresholds,
  );
  const reassessing =
    risk !== null &&
    (values.probability !== risk.probability || values.impact !== risk.impact) &&
    inherent !== null;
  const transition = reassessing ? levelTransitionOf(risk.level, inherent.level) : null;
  const divergent: RiskFormField[] =
    conflict && risk !== null && base !== null && risk.version !== base.version
      ? divergentFieldsOf(base, risk)
      : [];
  const pending = save.isPending;

  const phaseOptions = RISK_PHASES.map((phase) => ({
    value: phase,
    label: RISK_PHASE_LABELS[phase],
  }));
  const statusOptions = RISK_STATUSES.map((status) => ({
    value: status,
    label: RISK_STATUS_LABELS[status],
  }));
  const gridLabels = {
    probabilityAxisLabel: t('form.grid.probability'),
    impactAxisLabel: t('form.grid.impact'),
  };

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
            <Alert tone="warning" title={RISK_MESSAGES.versionConflict}>
              {divergent.length > 0 ? (
                <p className="mt-1 text-sm">
                  {t('form.conflict.changed', {
                    fields: divergent
                      .map((field) => t(`form.fieldNames.${field}` as 'form.fieldNames.title'))
                      .join(', '),
                  })}
                </p>
              ) : null}
              {risk !== null && base !== null && risk.version !== base.version ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="mt-2"
                  onClick={() => {
                    setValues(riskFormValuesOf(risk));
                    setBase(risk);
                    setMessages({});
                    setProblem(null);
                    setConflict(false);
                  }}
                >
                  {t('form.conflict.load')}
                </Button>
              ) : null}
            </Alert>
          ) : null}
          {problem?.kind === 'keyReused' ? (
            <Alert tone="warning" title={t('form.errors.keyReused')} />
          ) : null}
          {problem?.kind === 'permission' ? (
            <Alert tone="error" title={RISK_MESSAGES.permissionDenied} />
          ) : null}
          {problem?.kind === 'blocked' ? <Alert tone="error" title={problem.message} /> : null}
          {problem?.kind === 'unavailable' ? (
            <Alert tone="error" title={RISK_MESSAGES.unavailable}>
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
          id={fieldId('title')}
          label={t('form.fields.title')}
          error={messages.title}
          required
        >
          {(control) => (
            <input
              {...control}
              className={INPUT_CLASS}
              maxLength={RISK_LIMITS.titleMax}
              value={values.title}
              onChange={(event) => {
                set('title', event.target.value);
              }}
            />
          )}
        </FormField>
        <FormField
          id={fieldId('description')}
          label={t('form.fields.description')}
          error={messages.description}
        >
          {(control) => (
            <textarea
              {...control}
              className={TEXTAREA_CLASS}
              maxLength={RISK_LIMITS.descriptionMax}
              value={values.description}
              onChange={(event) => {
                set('description', event.target.value);
              }}
            />
          )}
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            id={fieldId('categoryId')}
            label={t('form.fields.categoryId')}
            value={values.categoryId}
            onChange={(value) => {
              set('categoryId', value);
            }}
            options={categoryOptions(categories.data, risk)}
            placeholder={t('form.select')}
            status={
              categories.data !== undefined ? 'ready' : categories.isError ? 'error' : 'pending'
            }
            emptyMessage={t('form.noCategories')}
            loadingLabel={t('form.loadingOptions')}
            errorLabel={t('form.loadError')}
            retryLabel={t('form.errors.retry')}
            onRetry={() => {
              void categories.refetch();
            }}
            error={messages.categoryId}
            required
          />
          <FormField
            id={fieldId('phase')}
            label={t('form.fields.phase')}
            error={messages.phase}
            required
          >
            {(control) => (
              <Select
                value={values.phase}
                onValueChange={(value) => {
                  set('phase', value as RiskPhase);
                }}
              >
                <SelectTrigger {...control}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {phaseOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
        </div>
        <FormField
          id={fieldId('cause')}
          label={t('form.fields.cause')}
          error={messages.cause}
          required
        >
          {(control) => (
            <textarea
              {...control}
              className={TEXTAREA_CLASS}
              maxLength={RISK_LIMITS.causeMax}
              value={values.cause}
              onChange={(event) => {
                set('cause', event.target.value);
              }}
            />
          )}
        </FormField>
        <FormField
          id={fieldId('consequence')}
          label={t('form.fields.consequence')}
          error={messages.consequence}
          required
        >
          {(control) => (
            <textarea
              {...control}
              className={TEXTAREA_CLASS}
              maxLength={RISK_LIMITS.consequenceMax}
              value={values.consequence}
              onChange={(event) => {
                set('consequence', event.target.value);
              }}
            />
          )}
        </FormField>

        <section aria-labelledby={fieldId('assessment')} className="flex flex-col gap-2">
          <h3 id={fieldId('assessment')} className="text-sm font-semibold">
            {t('form.assessment.title')}
          </h3>
          <p className="text-xs text-muted-foreground">{t('form.assessment.hint')}</p>
          <ProbabilityImpactGrid
            id={fieldId('grid')}
            label={t('form.assessment.gridLabel')}
            scale={scale}
            thresholds={levelThresholds}
            probability={values.probability}
            impact={values.impact}
            onChange={(probability, impact) => {
              setValues((current) => ({ ...current, probability, impact }));
              setMessages((current) => {
                const { probability: _p, impact: _i, ...rest } = current;
                return rest;
              });
            }}
            error={messages.probability ?? messages.impact}
            required
            {...gridLabels}
          />
          <div aria-live="polite" className="flex flex-wrap items-center gap-2 text-sm">
            {inherent === null ? (
              <span className="text-muted-foreground">{t('form.assessment.incomplete')}</span>
            ) : (
              <>
                <span>{t('form.assessment.score', { score: inherent.score })}</span>
                <LevelBadge level={inherent.level} />
                {transition !== null ? (
                  <span className="font-medium">
                    {t('form.assessment.transition', { transition })}
                  </span>
                ) : reassessing ? (
                  <span className="text-muted-foreground">
                    {t('form.assessment.sameLevel', { level: RISK_LEVEL_LABELS[risk.level] })}
                  </span>
                ) : null}
              </>
            )}
          </div>
        </section>

        <div className="grid gap-4 sm:grid-cols-2">
          <OwnerLookup
            id={fieldId('ownerId')}
            kind="USER"
            value={values.ownerId}
            name={values.ownerName}
            onChange={(id, name) => {
              setValues((current) => ({ ...current, ownerId: id, ownerName: name }));
            }}
            error={messages.ownerId}
            disabled={pending}
          />
          <OwnerLookup
            id={fieldId('ownerDepartmentId')}
            kind="DEPARTMENT"
            value={values.ownerDepartmentId}
            name={values.ownerDepartmentName}
            onChange={(id, name) => {
              setValues((current) => ({
                ...current,
                ownerDepartmentId: id,
                ownerDepartmentName: name,
              }));
            }}
            error={messages.ownerDepartmentId}
            disabled={pending}
          />
        </div>

        {risk !== null ? (
          <>
            <FormField
              id={fieldId('status')}
              label={t('form.fields.status')}
              error={messages.status}
              hint={t('form.statusHint')}
            >
              {(control) => (
                <Select
                  value={values.status}
                  onValueChange={(value) => {
                    set('status', value as RiskStatus);
                  }}
                >
                  <SelectTrigger {...control}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {statusOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>
            <section aria-labelledby={fieldId('residual')} className="flex flex-col gap-2">
              <h3 id={fieldId('residual')} className="text-sm font-semibold">
                {t('form.residual.title')}
              </h3>
              <p className="text-xs text-muted-foreground">{t('form.residual.hint')}</p>
              <ProbabilityImpactGrid
                id={fieldId('residualGrid')}
                label={t('form.residual.gridLabel')}
                scale={scale}
                thresholds={levelThresholds}
                probability={values.residualProbability}
                impact={values.residualImpact}
                onChange={(residualProbability, residualImpact) => {
                  setValues((current) => ({ ...current, residualProbability, residualImpact }));
                  setMessages((current) => {
                    const { residualProbability: _p, residualImpact: _i, ...rest } = current;
                    return rest;
                  });
                }}
                error={messages.residualProbability ?? messages.residualImpact}
                {...gridLabels}
              />
              <div aria-live="polite" className="flex flex-wrap items-center gap-2 text-sm">
                {residual === null ? (
                  <span className="text-muted-foreground">{t('form.residual.none')}</span>
                ) : (
                  <>
                    <span>{t('form.assessment.score', { score: residual.score })}</span>
                    <LevelBadge level={residual.level} />
                  </>
                )}
                {values.residualProbability !== null || values.residualImpact !== null ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setValues((current) => ({
                        ...current,
                        residualProbability: null,
                        residualImpact: null,
                      }));
                    }}
                  >
                    {t('form.residual.clear')}
                  </Button>
                ) : null}
              </div>
            </section>
          </>
        ) : null}
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
