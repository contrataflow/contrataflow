'use client';

import {
  Alert,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
  Label,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@contrataflow/ui';
import { ETP_COMPLETENESS_MESSAGES, PARCELING_DECISIONS } from '@contrataflow/validation';
import type {
  EtpDetailDto,
  EtpTemplateSectionDto,
  EtpUpdate,
  ParcelingDecision,
  Violation,
} from '@contrataflow/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { forwardRef, useId, useState } from 'react';

import { CorrelationCode } from '@/components/errors/correlation-code';
import { useTenantId } from '@/lib/session/session-context';

import { conclusionProblemOf, pendingSummaryOf, pendingTargetOf } from './etp-conclusion-model';
import type { ConclusionProblem, PendingTarget } from './etp-conclusion-model';
import { etpKeys, patchEtp } from './etp.api';
import { documentKeys } from '../documents/documents.api';

/*
 * Conclusão do ETP na SCR-008 (US-023): `EtpConclusionFieldset` — conclusão (viável/não viável) e
 * decisão sobre o parcelamento, gravadas pelo ETP-04 a cada escolha (`If-Match` da versão do ETP),
 * com o aviso de não viabilidade (RN-ETP-36: o reconhecimento explícito acontece no diálogo do
 * "Concluir ETP") — e `EtpPendingSummary` — "Pendências para concluir", a lista do DOC-08 com um
 * link focável por pendência (a seção, o quadro de itens/alternativas ou os campos de conclusão),
 * bloqueantes antes dos avisos, contagem anunciada (`aria-live`). Quem decide é a API: o botão
 * "Concluir ETP" é o do ciclo de vida do documento (DOC-10, `meta.allowedActions`).
 */

const CONCLUSIONS = ['VIABLE', 'NOT_VIABLE'] as const;

export interface EtpConclusionFieldsetProps {
  readonly etp: EtpDetailDto;
  readonly editable: boolean;
}

export const EtpConclusionFieldset = forwardRef<HTMLFieldSetElement, EtpConclusionFieldsetProps>(
  function EtpConclusionFieldset({ etp, editable }, ref) {
    const t = useTranslations('etp.conclusion');
    const tenantId = useTenantId();
    const queryClient = useQueryClient();
    const id = useId();
    const [problem, setProblem] = useState<ConclusionProblem | null>(null);

    const save = useMutation({
      mutationFn: (body: EtpUpdate) => patchEtp(etp.id, body, etp.version),
      onSuccess: (result) => {
        queryClient.setQueryData(etpKeys.detail(tenantId, etp.id), result);
        void queryClient.invalidateQueries({
          queryKey: documentKeys.validation(tenantId, etp.documentId),
        });
        setProblem(null);
      },
      onError: (error) => {
        setProblem(conclusionProblemOf(error));
        if (conclusionProblemOf(error).kind === 'message') {
          void queryClient.invalidateQueries({ queryKey: etpKeys.detail(tenantId, etp.id) });
        }
      },
    });

    const conclusion = etp.conclusion === 'PENDING' ? null : etp.conclusion;
    const disabled = !editable || save.isPending;

    return (
      <fieldset
        ref={ref}
        tabIndex={-1}
        aria-describedby={`${id}-hint`}
        className="flex min-w-0 flex-col gap-4 rounded-card bg-surface p-6 shadow-card"
      >
        <legend className="mb-1 p-0 text-section-title text-brand-ink">{t('title')}</legend>
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {t('hint')}
        </p>

        <Field
          group
          label={t('conclusionLabel')}
          required
          description={conclusion === null ? t('conclusionPending') : undefined}
        >
          <RadioGroup
            value={conclusion ?? ''}
            disabled={disabled}
            className="flex-row flex-wrap gap-x-6 gap-y-2"
            onValueChange={(value) => {
              const next = CONCLUSIONS.find((option) => option === value);
              if (next !== undefined) save.mutate({ conclusion: next });
            }}
          >
            {CONCLUSIONS.map((value) => (
              <div key={value} className="flex items-center gap-2">
                <RadioGroupItem
                  id={`${id}-conclusion-${value}`}
                  value={value}
                  data-field="conclusion"
                />
                <Label htmlFor={`${id}-conclusion-${value}`} className="font-normal">
                  {t(`conclusionOption.${value}`)}
                </Label>
              </div>
            ))}
          </RadioGroup>
        </Field>

        <Field label={t('parcelingLabel')} required className="max-w-sm">
          <Select
            value={etp.parcelingDecision ?? ''}
            disabled={disabled}
            onValueChange={(value) => {
              const next = PARCELING_DECISIONS.find((option) => option === value);
              if (next !== undefined) save.mutate({ parcelingDecision: next });
            }}
          >
            <SelectTrigger data-field="parcelingDecision">
              <SelectValue placeholder={t('parcelingPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {PARCELING_DECISIONS.map((value: ParcelingDecision) => (
                <SelectItem key={value} value={value}>
                  {t(`parcelingOption.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {save.isPending ? (
          <p role="status" className="text-xs text-muted-foreground">
            {t('saving')}
          </p>
        ) : null}
        {conclusion === 'NOT_VIABLE' ? (
          <Alert tone="warning" title={ETP_COMPLETENESS_MESSAGES.notViableConclusion}>
            <p>{t('notViableHint')}</p>
          </Alert>
        ) : null}
        {problem === null ? null : <ConclusionProblemAlert problem={problem} />}
      </fieldset>
    );
  },
);

function ConclusionProblemAlert({ problem }: { readonly problem: ConclusionProblem }) {
  const t = useTranslations('etp.conclusion.errors');
  const tErrors = useTranslations('errors');
  if (problem.kind === 'message') return <Alert tone="error" title={t(problem.key)} />;
  return (
    <Alert tone="error" title={t('unexpected')}>
      <div className="mt-2">
        <CorrelationCode
          correlationId={problem.correlationId}
          labels={{
            code: tErrors('correlation.label', { correlationId: problem.correlationId }),
            copy: tErrors('correlation.copy'),
            copied: tErrors('correlation.copied'),
          }}
        />
      </div>
    </Alert>
  );
}

export interface EtpPendingSummaryProps {
  readonly violations: readonly Violation[];
  /** `false` enquanto o DOC-08 não respondeu (sem pendências inventadas). */
  readonly loaded: boolean;
  readonly sections: readonly EtpTemplateSectionDto[];
  readonly onNavigate: (target: Exclude<PendingTarget, { kind: 'none' }>) => void;
}

export function EtpPendingSummary({
  violations,
  loaded,
  sections,
  onNavigate,
}: EtpPendingSummaryProps) {
  const t = useTranslations('etp.conclusion.pending');
  const id = useId();
  const { blocking, warnings } = pendingSummaryOf(violations);
  const render = (item: Violation, index: number) => {
    const target = pendingTargetOf(item, sections);
    return (
      <li key={`${item.code}-${item.sectionKey ?? item.field ?? ''}-${String(index)}`}>
        {target.kind === 'none' ? (
          <span>{item.message}</span>
        ) : (
          <button
            type="button"
            className="text-left text-primary underline underline-offset-2 hover:no-underline"
            onClick={() => {
              onNavigate(target);
            }}
          >
            {item.message}
          </button>
        )}
      </li>
    );
  };
  const count = blocking.length + warnings.length;
  // Aberta enquanto houver o que fazer; a pessoa pode recolher/abrir (a escolha vence).
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? count > 0;
  return (
    <Collapsible open={open} onOpenChange={setChosen} asChild>
      <section
        aria-labelledby={`${id}-title`}
        className="flex min-w-0 flex-col gap-2 rounded-card bg-surface p-4 shadow-card"
      >
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <h3 id={`${id}-title`} className="text-base font-semibold">
            <CollapsibleTrigger disabled={count === 0}>{t('title')}</CollapsibleTrigger>
          </h3>
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {!loaded
              ? t('loading')
              : blocking.length === 0
                ? t(warnings.length === 0 ? 'none' : 'onlyWarnings')
                : t('blocking', { count: blocking.length })}
          </p>
        </div>
        <CollapsibleContent className="flex flex-col gap-2">
          {blocking.length > 0 ? (
            <ul className="list-disc pl-5 text-sm">{blocking.map(render)}</ul>
          ) : null}
          {warnings.length > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium text-warning">{t('warningsTitle')}</span>
              <ul className="list-disc pl-5 text-sm">{warnings.map(render)}</ul>
            </div>
          ) : null}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}
