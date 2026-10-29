'use client';

import {
  Alert,
  ArrowRight,
  Button,
  Checkbox,
  CircleCheck,
  CircleX,
  Clock,
  Input,
  Label,
  LoaderCircle,
  Progress,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusChip,
} from '@contrataflow/ui';
import type { StatusTone } from '@contrataflow/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import {
  DEPARTMENT_TYPES,
  FIRST_STEPS,
  SUGGESTED_STRUCTURE,
  UNIT_NAME_MAX,
  creationOrder,
  isSelectable,
  nameErrors,
} from './suggested-structure';
import type { DepartmentType, SuggestedUnit } from './suggested-structure';

export interface CreateDepartmentInput {
  readonly name: string;
  readonly type: DepartmentType;
  /** Unidade superior já criada; `null` para unidade de primeiro nível do órgão. */
  readonly parentId: string | null;
}

export interface ImplementationAssistantProps {
  /** Nome do órgão selecionado (as unidades nascem nele). */
  readonly organizationName: string;
  /**
   * DEP-03 (US-102) com a `Idempotency-Key` da unidade: a mesma chave em cada repetição, para que
   * uma falha depois da gravação não duplique a unidade.
   */
  readonly createDepartment: (
    input: CreateDepartmentInput,
    idempotencyKey: string,
  ) => Promise<{ readonly id: string }>;
  /** "Agora não": esconde o assistente sem criar nada. */
  readonly onDismiss: () => void;
  /** Gera a chave de idempotência por unidade (padrão: `crypto.randomUUID`). */
  readonly newKey?: () => string;
}

type UnitProgress = 'pending' | 'creating' | 'created' | 'failed';

/** Situação de cada unidade na criação: tom e ícone do chip (o texto vem das mensagens). */
const PROGRESS_CHIP: Readonly<Record<UnitProgress, { tone: StatusTone; icon: ReactNode }>> = {
  pending: { tone: 'neutral', icon: <Clock aria-hidden="true" /> },
  creating: {
    tone: 'info',
    icon: <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" />,
  },
  created: { tone: 'success', icon: <CircleCheck aria-hidden="true" /> },
  failed: { tone: 'danger', icon: <CircleX aria-hidden="true" /> },
};

/**
 * Assistente de implantação (US-099 · FA-09 · SCR-032): estado vazio da aba "Secretarias" quando o
 * órgão ainda não tem unidades e o usuário tem `DEPARTMENT_MANAGE` (RN-TEN-18 —
 * `shouldShowImplementationAssistant`). Sugere a estrutura mínima editável, cria as unidades uma a
 * uma (pais primeiro, uma `Idempotency-Key` por unidade), anuncia o progresso em `aria-live`,
 * com a barra geral e a situação de cada unidade, mostra o que já foi criado numa falha parcial e
 * permite repetir; ao concluir, leva o foco ao título dos "Primeiros passos" (estado concluído com
 * ícone, uma frase e os atalhos da implantação).
 */
export function ImplementationAssistant({
  organizationName,
  createDepartment,
  onDismiss,
  newKey = () => crypto.randomUUID(),
}: ImplementationAssistantProps) {
  const t = useTranslations('implementationAssistant');
  const formId = useId();
  const [units, setUnits] = useState<SuggestedUnit[]>(() => [...SUGGESTED_STRUCTURE]);
  const [progress, setProgress] = useState<Record<string, UnitProgress>>({});
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [done, setDone] = useState(false);
  const created = useRef(new Map<string, string>());
  const keys = useRef(new Map<string, string>());
  const doneHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (done) doneHeading.current?.focus();
  }, [done]);

  const errors = nameErrors(units);
  const plan = creationOrder(units);
  const createdCount = plan.filter((unit) => progress[unit.key] === 'created').length;
  const locked = running || Object.keys(progress).length > 0;

  const update = (key: string, patch: Partial<SuggestedUnit>) => {
    setUnits((current) => current.map((unit) => (unit.key === key ? { ...unit, ...patch } : unit)));
  };

  const run = async () => {
    setSubmitted(true);
    if (Object.keys(errors).length > 0 || plan.length === 0) return;
    setRunning(true);
    setFailed(false);
    for (const unit of plan) {
      if (created.current.has(unit.key)) continue;
      setProgress((current) => ({ ...current, [unit.key]: 'creating' }));
      const key = keys.current.get(unit.key) ?? newKey();
      keys.current.set(unit.key, key);
      try {
        const parentId =
          unit.parentKey === null ? null : (created.current.get(unit.parentKey) ?? null);
        const result = await createDepartment(
          { name: unit.name.trim(), type: unit.type, parentId },
          key,
        );
        created.current.set(unit.key, result.id);
        setProgress((current) => ({ ...current, [unit.key]: 'created' }));
      } catch {
        // Filhos dependem do pai: para aqui e oferece repetir (a chave da unidade é mantida).
        setProgress((current) => ({ ...current, [unit.key]: 'failed' }));
        setFailed(true);
        setRunning(false);
        return;
      }
    }
    setRunning(false);
    setDone(true);
  };

  if (done) {
    return (
      <section aria-labelledby={`${formId}-done`} className="flex flex-col gap-5">
        <div className="flex flex-col items-center gap-2.5 text-center">
          <span className="grid size-11 place-items-center rounded-control bg-success-soft text-success-soft-foreground">
            <CircleCheck aria-hidden="true" className="size-[1.375rem]" />
          </span>
          <h2
            id={`${formId}-done`}
            ref={doneHeading}
            tabIndex={-1}
            className="text-lg font-bold text-brand-ink outline-none"
          >
            {t('firstSteps.title')}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t('firstSteps.description', { count: createdCount })}
          </p>
        </div>
        <ul className="mx-auto flex w-full max-w-xl flex-col divide-y divide-border">
          {FIRST_STEPS.map((step) => (
            <li key={step.key}>
              <Link
                href={step.href}
                className="flex min-h-11 items-center justify-between gap-3 py-2.5 text-sm font-semibold text-primary-soft-foreground hover:underline"
              >
                {t(`firstSteps.items.${step.key}`)}
                <ArrowRight aria-hidden="true" className="size-4 flex-none" />
              </Link>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  return (
    <section aria-labelledby={`${formId}-title`} className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 id={`${formId}-title`} className="text-lg font-semibold">
          {t('title')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t('description', { organization: organizationName })}
        </p>
      </header>

      <fieldset className="flex flex-col gap-3" disabled={locked}>
        <legend className="sr-only">{t('legend')}</legend>
        {units.map((unit) => {
          const selectable = isSelectable(units, unit);
          const error = submitted && unit.selected && selectable ? errors[unit.key] : undefined;
          const state = progress[unit.key];
          const nameId = `${formId}-${unit.key}-name`;
          const typeId = `${formId}-${unit.key}-type`;
          return (
            <div
              key={unit.key}
              className={
                unit.parentKey === null ? 'flex flex-col gap-2' : 'ml-8 flex flex-col gap-2'
              }
            >
              <div className="flex flex-wrap items-end gap-3">
                <Checkbox
                  className="mb-3"
                  checked={unit.selected && selectable}
                  disabled={!selectable}
                  aria-label={t('include', { name: unit.name || t('unnamed') })}
                  onCheckedChange={(checked) => {
                    update(unit.key, { selected: checked === true });
                  }}
                />
                <div className="flex min-w-48 flex-1 flex-col gap-1">
                  <Label htmlFor={nameId}>
                    {unit.parentKey === null ? t('fields.unit') : t('fields.subunit')}
                  </Label>
                  <Input
                    id={nameId}
                    value={unit.name}
                    maxLength={UNIT_NAME_MAX + 1}
                    disabled={!unit.selected || !selectable}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? `${nameId}-error` : undefined}
                    onChange={(event) => {
                      update(unit.key, { name: event.target.value });
                    }}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor={typeId}>{t('fields.type')}</Label>
                  <Select
                    value={unit.type}
                    disabled={locked || !unit.selected || !selectable}
                    onValueChange={(value) => {
                      update(unit.key, { type: value as DepartmentType });
                    }}
                  >
                    <SelectTrigger id={typeId} className="min-w-44">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DEPARTMENT_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {t(`types.${type}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {state ? (
                  <StatusChip
                    className="mb-3"
                    tone={PROGRESS_CHIP[state].tone}
                    icon={PROGRESS_CHIP[state].icon}
                  >
                    {t(`progress.${state}`)}
                  </StatusChip>
                ) : null}
              </div>
              {error ? (
                <p id={`${nameId}-error`} className="text-sm text-destructive">
                  {t(`errors.${error}`)}
                </p>
              ) : null}
            </div>
          );
        })}
      </fieldset>

      {locked ? (
        <Progress
          aria-label={t('progress.summary', { created: createdCount, total: plan.length })}
          value={createdCount}
          max={Math.max(plan.length, 1)}
          tone={failed ? 'danger' : createdCount === plan.length ? 'success' : 'info'}
        />
      ) : null}
      <p aria-live="polite" className="text-sm">
        {running || failed || createdCount > 0
          ? t('progress.summary', { created: createdCount, total: plan.length })
          : ''}
      </p>

      {failed ? (
        <Alert tone="error" title={t('partialFailure.title')}>
          {t('partialFailure.description', { created: createdCount, total: plan.length })}
        </Alert>
      ) : null}

      {submitted && plan.length === 0 ? (
        <Alert tone="warning" title={t('nothingSelected')} />
      ) : null}

      <div className="flex flex-wrap gap-3">
        <Button type="button" disabled={running} onClick={() => void run()}>
          {failed ? t('actions.retry') : t('actions.create')}
        </Button>
        {Object.keys(progress).length === 0 ? (
          <Button type="button" variant="ghost" onClick={onDismiss}>
            {t('actions.dismiss')}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
