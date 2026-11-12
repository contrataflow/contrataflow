'use client';

import { cx } from '@contrataflow/ui';
import type { ActionStageDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId, useRef } from 'react';
import type { KeyboardEvent } from 'react';

import { BranchChip } from '../workflows/parallel-structure';

export interface BranchSelectorProps {
  /** `stages[]` do PRC-08. Com uma etapa só (ou nenhuma) o seletor não aparece. */
  readonly stages: readonly ActionStageDto[] | undefined;
  /** `processStageId` escolhido. */
  readonly value: string | null;
  readonly onChange: (processStageId: string) => void;
}

/**
 * `BranchSelector` (US-124): no paralelismo o usuário escolhe em qual ramo age. Grupo de opções
 * (`radiogroup`) navegável por setas, Home e End; o ramo atual é anunciado em região `aria-live`.
 * Fora do paralelismo não renderiza nada (UI idêntica à do MVP 1).
 */
export function BranchSelector({ stages, value, onChange }: BranchSelectorProps) {
  const t = useTranslations('processActions.branches');
  const labelId = useId();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  if (stages === undefined || stages.length < 2) return null;

  const current = stages.find((stage) => stage.processStageId === value);
  const select = (stage: ActionStageDto) => {
    onChange(stage.processStageId);
    refs.current[stage.processStageId]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = stages.length - 1;
    const target: Record<string, number> = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowDown: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      ArrowUp: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    };
    const next = target[event.key];
    const stage = next === undefined ? undefined : stages[next];
    if (stage === undefined) return;
    event.preventDefault();
    select(stage);
  };

  return (
    <div className="flex flex-col gap-2">
      <span id={labelId} className="text-sm font-medium">
        {t('label')}
      </span>
      <div role="radiogroup" aria-labelledby={labelId} className="flex flex-wrap gap-2">
        {stages.map((stage, index) => {
          const selected = stage.processStageId === current?.processStageId;
          return (
            <button
              key={stage.processStageId}
              ref={(element) => {
                refs.current[stage.processStageId] = element;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected || (current === undefined && index === 0) ? 0 : -1}
              data-stage-id={stage.processStageId}
              className={cx(
                'inline-flex min-h-9 items-center gap-2 rounded-control border px-3 text-sm transition-colors',
                selected
                  ? 'border-primary bg-primary-soft font-bold text-primary-soft-foreground'
                  : 'border-border bg-surface text-foreground hover:bg-neutral-soft',
              )}
              onClick={() => {
                select(stage);
              }}
              onKeyDown={(event) => {
                onKeyDown(event, index);
              }}
            >
              <span>{stage.stageName}</span>
              {stage.branchKey === null ? null : <BranchChip branchKey={stage.branchKey} />}
              {stage.isMine ? (
                <span className="text-xs text-muted-foreground">({t('mine')})</span>
              ) : null}
            </button>
          );
        })}
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {current === undefined ? '' : t('current', { name: current.stageName })}
      </p>
    </div>
  );
}
