'use client';

import { Alert, Button } from '@contrataflow/ui';
import {
  RISK_MAP_TREATMENT_REQUIRED_LEVELS,
  RISK_PHASE_LABELS,
  TREATMENT_TYPE_LABELS,
  assessRisk,
} from '@contrataflow/validation';
import type {
  AiGenerationDto,
  AiProposedRisk,
  ApplyAiRisksInput,
  RiskLevelThreshold,
} from '@contrataflow/validation';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { LevelBadge } from '@/features/risks/level-badge';
import { applyAiRisks, riskKeys, useRiskCategories } from '@/features/risks/risks.api';
import { isApiError } from '@/lib/api/api-error';
import { useIdempotentMutation } from '@/lib/api/use-idempotent-mutation';
import { useTenantId } from '@/lib/session/session-context';

import { aiKeys } from './ai.api';

/*
 * `AiRiskProposalList` (US-119 · SCR-117 no SCR-011 · RN-AI-39/40): um cartão por risco proposto
 * (título, categoria, fase, P×I com o nível pela escala VIGENTE, causa, consequência, justificativa)
 * com os tratamentos. A proposta é somente leitura — ajustes depois de aplicar (RSK-04). Marcados
 * por padrão: todos os riscos, exceto os parecidos com um já registrado (FA-02), e todos os
 * tratamentos. "Aplicar selecionados" envia o RSK-11; os riscos criados ficam "Gerado por IA" até a
 * revisão. Risco Alto/Extremo sem tratamento marcado ganha o aviso da RN-RISK-21 (FA-06).
 */

export interface RiskSelection {
  readonly risks: ReadonlySet<string>;
  readonly treatments: ReadonlySet<string>;
}

/** Marcação padrão (fluxo principal 7 · FA-02): parecidos com risco existente vêm desmarcados. */
export function defaultRiskSelection(risks: readonly AiProposedRisk[]): RiskSelection {
  return {
    risks: new Set(
      risks.filter((risk) => risk.similarToRiskId === undefined).map((risk) => risk.proposalKey),
    ),
    treatments: new Set(
      risks.flatMap((risk) => risk.treatments.map((treatment) => treatment.proposalKey)),
    ),
  };
}

/** Corpo do RSK-11: só os riscos marcados, cada um com os próprios tratamentos marcados. */
export function applyBodyOf(
  generationId: string,
  risks: readonly AiProposedRisk[],
  selection: RiskSelection,
): ApplyAiRisksInput {
  return {
    generationId,
    risks: risks
      .filter((risk) => selection.risks.has(risk.proposalKey))
      .map((risk) => ({
        proposalKey: risk.proposalKey,
        treatments: risk.treatments
          .map((treatment) => treatment.proposalKey)
          .filter((key) => selection.treatments.has(key)),
      })),
  };
}

/** FA-06: riscos Altos/Extremos marcados sem nenhum tratamento marcado. */
export function highWithoutTreatment(
  risks: readonly AiProposedRisk[],
  selection: RiskSelection,
  thresholds: readonly RiskLevelThreshold[],
): string[] {
  return risks
    .filter(
      (risk) =>
        selection.risks.has(risk.proposalKey) &&
        RISK_MAP_TREATMENT_REQUIRED_LEVELS.includes(
          assessRisk(risk.probability, risk.impact, thresholds).level,
        ) &&
        !risk.treatments.some((treatment) => selection.treatments.has(treatment.proposalKey)),
    )
    .map((risk) => risk.title);
}

export interface AiRiskProposalListProps {
  readonly generation: AiGenerationDto;
  readonly processId: string;
  /** Faixas vigentes (RSK-01 `meta.levelThresholds`) — o nível exibido é o que será gravado. */
  readonly levelThresholds: readonly RiskLevelThreshold[];
  /** Riscos já registrados (código do selo "Parecido com R03"). */
  readonly existing: readonly { readonly id: string; readonly code: string }[];
  readonly discarding: boolean;
  readonly onDiscard: () => void;
  readonly onApplied: (count: number) => void;
}

export function AiRiskProposalList({
  generation,
  processId,
  levelThresholds,
  existing,
  discarding,
  onDiscard,
  onApplied,
}: AiRiskProposalListProps) {
  const t = useTranslations('ai.riskProposal');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const legendId = useId();
  const risks = generation.output?.risks ?? [];
  const categories = useRiskCategories();
  const [selection, setSelection] = useState<RiskSelection>(() => defaultRiskSelection(risks));
  const [error, setError] = useState<string | null>(null);
  const codes = new Map(existing.map((risk) => [risk.id, risk.code]));
  const categoryLabel = (code: string) =>
    categories.data?.find((item) => item.code === code)?.label ?? code;

  const apply = useIdempotentMutation({
    mutationFn: (body: ApplyAiRisksInput, context) => applyAiRisks(processId, body, context),
  });

  const toggle = (kind: keyof RiskSelection, key: string, checked: boolean) => {
    setSelection((current) => {
      const next = new Set(current[kind]);
      if (checked) next.add(key);
      else next.delete(key);
      return { ...current, [kind]: next };
    });
  };

  const body = applyBodyOf(generation.id, risks, selection);
  const warnings = highWithoutTreatment(risks, selection, levelThresholds);

  async function submit() {
    if (body.risks.length === 0) {
      setError(t('none'));
      return;
    }
    setError(null);
    try {
      const result = await apply.submit(body);
      void queryClient.invalidateQueries({ queryKey: riskKeys.list(tenantId, processId) });
      void queryClient.invalidateQueries({ queryKey: aiKeys.generation(tenantId, generation.id) });
      void queryClient.invalidateQueries({ queryKey: aiKeys.history(tenantId, processId) });
      onApplied(result.risks.length);
    } catch (failure) {
      const code = isApiError(failure) ? failure.code : null;
      setError(
        code === 'AI_GENERATION_NOT_APPLICABLE'
          ? t('notApplicable')
          : code === 'AI_GENERATION_NOT_OWNED'
            ? t('notOwned')
            : code === 'DOCUMENT_NOT_EDITABLE'
              ? t('locked')
              : code === 'VALIDATION_ERROR'
                ? t('none')
                : t('failed'),
      );
    }
  }

  return (
    <fieldset className="flex min-w-0 flex-col gap-3" aria-describedby={legendId}>
      <legend className="font-medium">{t('legend')}</legend>
      <p id={legendId} className="text-xs text-muted-foreground">
        {t('hint')}
      </p>
      <ul className="flex flex-col gap-3">
        {risks.map((risk) => {
          const { level, score } = assessRisk(risk.probability, risk.impact, levelThresholds);
          const similarCode =
            risk.similarToRiskId === undefined ? undefined : codes.get(risk.similarToRiskId);
          const checkboxId = `${legendId}-${risk.proposalKey}`;
          return (
            <li key={risk.proposalKey} className="rounded-md border border-border p-3">
              <div className="flex items-start gap-2">
                <input
                  id={checkboxId}
                  type="checkbox"
                  className="mt-1 size-4"
                  checked={selection.risks.has(risk.proposalKey)}
                  onChange={(event) => {
                    toggle('risks', risk.proposalKey, event.target.checked);
                  }}
                />
                <div className="flex min-w-0 flex-col gap-1">
                  <label htmlFor={checkboxId} className="font-medium break-words">
                    {risk.title}
                  </label>
                  <span className="text-xs text-muted-foreground">
                    {categoryLabel(risk.categoryCode)} · {RISK_PHASE_LABELS[risk.phase]}
                  </span>
                  <span className="inline-flex flex-wrap items-center gap-1">
                    <LevelBadge level={level} score={score} />
                    <span className="text-xs text-muted-foreground">
                      {t('formula', { probability: risk.probability, impact: risk.impact })}
                    </span>
                  </span>
                  {risk.similarToRiskId === undefined ? null : (
                    <span className="self-start rounded-control border border-warning bg-warning-soft px-2 py-0.5 text-xs font-semibold text-foreground">
                      {similarCode === undefined
                        ? t('similarUnknown')
                        : t('similar', { code: similarCode })}
                    </span>
                  )}
                </div>
              </div>
              <dl className="mt-2 grid gap-1 text-sm">
                {risk.description === '' ? null : (
                  <div>
                    <dt className="font-medium">{t('description')}</dt>
                    <dd className="break-words text-muted-foreground">{risk.description}</dd>
                  </div>
                )}
                <div>
                  <dt className="font-medium">{t('cause')}</dt>
                  <dd className="break-words text-muted-foreground">{risk.cause}</dd>
                </div>
                <div>
                  <dt className="font-medium">{t('consequence')}</dt>
                  <dd className="break-words text-muted-foreground">{risk.consequence}</dd>
                </div>
                {risk.rationale === '' ? null : (
                  <div>
                    <dt className="font-medium">{t('rationale')}</dt>
                    <dd className="break-words text-muted-foreground">{risk.rationale}</dd>
                  </div>
                )}
              </dl>
              <fieldset className="mt-2 flex flex-col gap-1">
                <legend className="text-sm font-medium">{t('treatments')}</legend>
                {risk.treatments.map((treatment) => (
                  <label key={treatment.proposalKey} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1 size-4"
                      disabled={!selection.risks.has(risk.proposalKey)}
                      checked={selection.treatments.has(treatment.proposalKey)}
                      onChange={(event) => {
                        toggle('treatments', treatment.proposalKey, event.target.checked);
                      }}
                    />
                    <span className="break-words">
                      <span className="font-medium">{TREATMENT_TYPE_LABELS[treatment.type]}: </span>
                      {treatment.description}
                    </span>
                  </label>
                ))}
              </fieldset>
            </li>
          );
        })}
      </ul>
      {warnings.length === 0 ? null : (
        <Alert tone="warning" live={false} title={t('highWithoutTreatment')}>
          <ul className="list-disc pl-5">
            {warnings.map((title) => (
              <li key={title}>{title}</li>
            ))}
          </ul>
        </Alert>
      )}
      <div aria-live="polite">
        {error === null ? null : (
          <Alert tone="error" title={error}>
            {null}
          </Alert>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={apply.isPending}
          aria-busy={apply.isPending}
          onClick={() => void submit()}
        >
          {apply.isPending ? t('applying') : t('action', { count: body.risks.length })}
        </Button>
        <Button variant="secondary" disabled={discarding} onClick={onDiscard}>
          {discarding ? t('discarding') : t('discard')}
        </Button>
      </div>
    </fieldset>
  );
}
